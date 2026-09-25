/**
 * agents/secret-agent.ts
 *
 * Automated Secret Scanner Agent for GitGuard.
 *
 * Workflow:
 *   1. Shell out to `gitleaks` (JSON output) against the git diff.
 *   2. If candidate secrets are found, send them to Claude Haiku (or Ollama locally)
 *      with a system prompt that filters false positives (mock keys, tests, docs).
 *   3. Returns array of { file, line, confirmed, reason }.
 *   4. Creates a GitHub Check Run ("GitGuard / Secrets"):
 *      - If confirmed secrets exist: fails check run with inline file/line annotations.
 *      - Otherwise: posts a passing check run.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { Octokit } from "@octokit/core";
import { generateAICompletion } from "@/lib/ai-client";
import {
  fetchGitGuardIgnore,
  checkIsIgnored,
  logIgnoredFindingToFirestore,
  type GitGuardIgnoreRule,
} from "@/lib/gitguard-ignore";

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SecretVerificationResult {
  file: string;
  line: number;
  confirmed: boolean;
  reason: string;
}

export interface GitleaksFinding {
  Description: string;
  StartLine: number;
  EndLine: number;
  StartColumn?: number;
  EndColumn?: number;
  Match: string;
  Secret: string;
  File: string;
  RuleID: string;
  Entropy?: number;
}

export interface RunSecretScanOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  sha: string;
  diff: string;
  installationId?: string | number;
  ignoreRules?: GitGuardIgnoreRule[];
}

// ── System Prompt for False-Positive Filtering ────────────────────────────────

const SECRET_REVIEW_SYSTEM_PROMPT = `You are an elite application security expert specializing in detecting real credentials, API tokens, private keys, and secrets while eliminating false positives.

Analyze the candidate secret findings extracted from a git diff.
Carefully distinguish real leaked credentials from common false positives such as:
1. Dummy/mock/placeholder strings (e.g., "YOUR_API_KEY_HERE", "example-key", "dummy-secret-12345", "1234567890abcdef", "TODO_ADD_KEY", "test-token").
2. Example documentation, sample configs, or unit test mock fixtures (e.g., test/fixture files, mock response payloads).
3. Public IDs, git commit hashes, UUIDs, or random non-secret identifiers mistakenly flagged as high entropy.
4. Non-sensitive tokens (e.g. public Stripe publishable keys 'pk_test_*', standard package hashes).

For each candidate, respond with:
- file: the filepath
- line: line number
- confirmed: true ONLY if you are highly confident this is a real or potentially active secret leak; false if it is a test fixture, dummy placeholder, or documentation example.
- reason: concise explanation for your judgment.

OUTPUT FORMAT:
You MUST respond with a valid JSON array matching this exact schema and nothing else:
[
  {
    "file": "path/to/file",
    "line": 42,
    "confirmed": true,
    "reason": "Live high-entropy AWS access key in production config"
  }
]`;

// ── 1. Gitleaks Execution ─────────────────────────────────────────────────────

/**
 * Locate gitleaks binary from PATH or standard Homebrew/Unix locations.
 */
async function findGitleaksPath(): Promise<string> {
  if (process.env.GITLEAKS_PATH) return process.env.GITLEAKS_PATH;

  const candidatePaths = [
    "gitleaks",
    "/opt/homebrew/bin/gitleaks",
    "/usr/local/bin/gitleaks",
    "/usr/bin/gitleaks",
  ];

  for (const candidate of candidatePaths) {
    try {
      await execFileAsync(candidate, ["version"]);
      return candidate;
    } catch {
      // Continue checking next candidate
    }
  }

  return "gitleaks";
}

/**
 * Shells out to gitleaks against the raw diff and parses the resulting JSON.
 */
export async function runGitleaksScan(diff: string): Promise<GitleaksFinding[]> {
  if (!diff || diff.trim().length === 0) {
    return [];
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitguard-diff-"));
  const diffPath = path.join(tempDir, "patch.diff");
  const reportPath = path.join(tempDir, "gitleaks-report.json");

  try {
    await fs.writeFile(diffPath, diff, "utf-8");
    const gitleaksBin = await findGitleaksPath();

    // Run gitleaks detect against the diff file
    // Note: gitleaks exits with 1 when leaks are found, which is expected.
    try {
      await execFileAsync(gitleaksBin, [
        "detect",
        "--no-git",
        "--source",
        diffPath,
        "--report-format",
        "json",
        "--report-path",
        reportPath,
        "--exit-code",
        "1",
      ]);
    } catch (execError: unknown) {
      // Exit code 1 means leaks found; exit code 0 means clean
      const err = execError as { code?: number; stdout?: string; stderr?: string };
      if (err.code !== 1 && err.code !== 0) {
        console.warn(`[gitleaks] Warning during execution:`, err.stderr || err.stdout || err);
      }
    }

    // Read the report file if produced
    try {
      const reportRaw = await fs.readFile(reportPath, "utf-8");
      if (!reportRaw.trim()) return [];
      const findings = JSON.parse(reportRaw) as GitleaksFinding[];
      if (!Array.isArray(findings)) return [];

      // Map patch file lines back to actual repository file paths and real line numbers
      const diffLineMap = buildDiffLineMap(diff);

      return findings.map((f) => {
        const mapped = diffLineMap.get(f.StartLine);
        if (mapped && mapped.filePath) {
          return {
            ...f,
            File: mapped.filePath,
            StartLine: mapped.targetLine,
            EndLine: mapped.targetLine,
          };
        }
        return f;
      });
    } catch {
      // No report produced or empty -> no findings
      return [];
    }
  } catch (err) {
    console.error("[gitleaks] Error running scan:", err);
    return [];
  } finally {
    // Clean up temporary files
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Builds a mapping from patch line index (1-based) to the actual repository file
 * path and target file line number for lines added in git diff hunks.
 */
function buildDiffLineMap(
  diff: string
): Map<number, { filePath: string; targetLine: number; content: string }> {
  const map = new Map<number, { filePath: string; targetLine: number; content: string }>();
  const lines = diff.split("\n");
  let currentFile = "";
  let currentTargetLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const patchLineNumber = i + 1;
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match) {
        currentFile = match[2];
      }
    } else if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
    } else if (line.startsWith("@@ ")) {
      const hunkMatch = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        currentTargetLine = parseInt(hunkMatch[1], 10) - 1;
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      currentTargetLine++;
      map.set(patchLineNumber, {
        filePath: currentFile,
        targetLine: currentTargetLine,
        content: line.slice(1),
      });
    } else if (!line.startsWith("-")) {
      if (currentTargetLine > 0) {
        currentTargetLine++;
      }
    }
  }

  return map;
}

// ── 2. Claude Haiku / Ollama False-Positive Filter ─────────────────────────────

/**
 * Sends candidate findings to Claude Haiku or Ollama locally for false-positive validation.
 */
export async function filterSecretsWithLLM(
  findings: GitleaksFinding[],
  diffSnippet: string
): Promise<SecretVerificationResult[]> {
  if (findings.length === 0) {
    return [];
  }

  const userPrompt = `Candidate secret findings to review:
${JSON.stringify(
  findings.map((f) => ({
    rule: f.RuleID,
    description: f.Description,
    file: f.File,
    line: f.StartLine,
    matchMasked: f.Secret ? `${f.Secret.slice(0, 4)}***${f.Secret.slice(-4)}` : f.Match,
  })),
  null,
  2
)}

Diff context snippet:
\`\`\`diff
${diffSnippet.slice(0, 3000)}
\`\`\`

Evaluate each finding and return the JSON array of { file, line, confirmed, reason }.`;

  // Use Groq API with Gemini fallback
  console.log(`[secret-agent] Querying AI model (Groq primary, Gemini fallback) to filter false positives...`);
  const rawCompletion = await generateAICompletion({
    messages: [
      { role: "system", content: SECRET_REVIEW_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    jsonMode: true,
  });

  if (rawCompletion) {
    return parseLLMJsonResults(rawCompletion, findings);
  }

  // Fallback: If no AI is reachable, default to treating all gitleaks findings as confirmed
  console.log(`[secret-agent] No AI response; defaulting to raw gitleaks findings`);
  return findings.map((f) => ({
    file: f.File,
    line: f.StartLine,
    confirmed: true,
    reason: `Gitleaks flagged rule ${f.RuleID} (${f.Description})`,
  }));
}

function parseLLMJsonResults(
  rawText: string,
  fallbackFindings: GitleaksFinding[]
): SecretVerificationResult[] {
  try {
    // Extract JSON block if surrounded by markdown code fences
    const cleanJson = rawText.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(cleanJson);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => ({
        file: String(item.file || ""),
        line: Number(item.line || 1),
        confirmed: Boolean(item.confirmed),
        reason: String(item.reason || "Secret detected"),
      }));
    }
  } catch (err) {
    console.warn("[secret-agent] Failed to parse LLM JSON response:", rawText);
  }

  return fallbackFindings.map((f) => ({
    file: f.File,
    line: f.StartLine,
    confirmed: true,
    reason: `Potential secret flagged by ${f.RuleID}`,
  }));
}

// ── 3. GitHub Check Run Creation ──────────────────────────────────────────────

/**
 * Runs the full Secret Agent pipeline:
 *  1. Scans the diff with gitleaks.
 *  2. Evaluates findings with Claude Haiku / Ollama.
 *  3. Posts a passing or failing "GitGuard / Secrets" Check Run on GitHub.
 */
export async function runSecretScan({
  octokit,
  owner,
  repo,
  sha,
  diff,
  installationId,
  ignoreRules,
}: RunSecretScanOptions): Promise<{
  passed: boolean;
  confirmedCount: number;
  results: SecretVerificationResult[];
  ignoredCount: number;
}> {
  console.log(`[secret-agent] Running secret scan for ${owner}/${repo} @ ${sha.slice(0, 7)}`);

  // Step 1: Run gitleaks
  const gitleaksFindings = await runGitleaksScan(diff);
  console.log(`[secret-agent] Gitleaks identified ${gitleaksFindings.length} candidate finding(s)`);

  let confirmedSecrets: SecretVerificationResult[] = [];
  let allResults: SecretVerificationResult[] = [];

  // Step 2: Validate findings with LLM if any were found
  if (gitleaksFindings.length > 0) {
    allResults = await filterSecretsWithLLM(gitleaksFindings, diff);
    confirmedSecrets = allResults.filter((r) => r.confirmed);
    console.log(
      `[secret-agent] LLM validation complete: ${confirmedSecrets.length} confirmed, ${allResults.length - confirmedSecrets.length} dismissed as false positives`
    );
  }

  // Step 3: Filter against .gitguardignore
  const rules = ignoreRules || (await fetchGitGuardIgnore(octokit, owner, repo, sha));
  const activeSecrets: SecretVerificationResult[] = [];
  let ignoredCount = 0;

  for (const secret of confirmedSecrets) {
    const ignoreCheck = checkIsIgnored(secret.file, rules);
    if (ignoreCheck.ignored && ignoreCheck.rule && ignoreCheck.rule.valid) {
      ignoredCount++;
      console.log(
        `[secret-agent] Skipping whitelisted secret in ${secret.file}:${secret.line} (Pattern: ${ignoreCheck.rule.pattern}, Reason: ${ignoreCheck.rule.reason})`
      );
      await logIgnoredFindingToFirestore({
        installationId: installationId || "0",
        repo: `${owner}/${repo}`,
        sha,
        file: secret.file,
        line: secret.line,
        agent: "SecretAgent",
        rulePattern: ignoreCheck.rule.pattern,
        reason: ignoreCheck.rule.reason,
        findingSummary: `Whitelisted secret: ${secret.reason}`,
        timestamp: Date.now(),
      });
      continue;
    }
    activeSecrets.push(secret);
  }

  if (ignoredCount > 0) {
    console.log(`[secret-agent] .gitguardignore whitelisted ${ignoredCount} secret finding(s).`);
  }

  const passed = activeSecrets.length === 0;

  // Step 4: Create GitHub Check Run
  const checkName = "GitGuard / Secrets";

  if (passed) {
    const summary =
      ignoredCount > 0
        ? `GitGuard secret scan passed. (Note: ${ignoredCount} finding(s) whitelisted by .gitguardignore with verified reason).`
        : gitleaksFindings.length > 0
        ? `Scan completed. Gitleaks flagged ${gitleaksFindings.length} candidate pattern(s), but all were verified as false positives, mock credentials, or test fixtures by AI review.`
        : `GitGuard secret scan passed. No secrets detected in this changeset.`;

    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: checkName,
      head_sha: sha,
      status: "completed",
      conclusion: "success",
      output: {
        title: "No secrets detected",
        summary,
      },
    });

    console.log(`[secret-agent] Posted SUCCESS check run for ${owner}/${repo} @ ${sha.slice(0, 7)}`);
  } else {
    // Failing check run with annotations
    const annotations = activeSecrets.map((secret) => ({
      path: secret.file,
      start_line: secret.line || 1,
      end_line: secret.line || 1,
      annotation_level: "failure" as const,
      title: "Secret Leak Detected",
      message: secret.reason,
    }));

    const markdownList = activeSecrets
      .map((s) => `- **\`${s.file}:${s.line}\`**: ${s.reason}`)
      .join("\n");

    const summary = [
      `### 🚨 Confirmed Secret(s) Found`,
      `GitGuard detected **${activeSecrets.length}** confirmed sensitive credential(s) in this commit:`,
      markdownList,
      `**Action required:** Revoke and rotate these credentials immediately and remove them from git history.`,
      ignoredCount > 0
        ? `\n> 🛡️ **.gitguardignore**: ${ignoredCount} secret finding(s) were whitelisted and audited.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: checkName,
      head_sha: sha,
      status: "completed",
      conclusion: "failure",
      output: {
        title: `${activeSecrets.length} secret(s) detected`,
        summary,
        annotations: annotations.slice(0, 50), // GitHub caps annotations at 50 per call
      },
    });

    console.log(`[secret-agent] Posted FAILURE check run for ${owner}/${repo} @ ${sha.slice(0, 7)}`);
  }

  return {
    passed,
    confirmedCount: activeSecrets.length,
    results: allResults,
    ignoredCount,
  };
}
