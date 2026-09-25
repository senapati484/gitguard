/**
 * agents/bug-agent.ts
 *
 * Automated Bug Scanner Agent for GitGuard.
 *
 * Responsibilities:
 *   1. Extract only changed hunks (not full files) from the git diff.
 *   2. Send changed hunks to the model (Groq as primary, Gemini as fallback).
 *   3. Scoped strictly to:
 *      - Null / undefined dereferences
 *      - Unhandled promises & async error omissions
 *      - Race conditions & concurrency hazards
 *      - Off-by-one boundary errors
 *      - STRICTLY NO STYLISTIC OR LINT COMMENTS.
 *   4. Parses structured results: { file, line, severity, message }.
 *   5. Posts a GitHub Check Run ("GitGuard / Bugs") with inline annotations.
 *      - Severity threshold: "critical" and "high" fail the check.
 *      - "medium" and "low" post as warnings (conclusion: "neutral"), warning developers
 *        without blocking/failing the pull request.
 */

import type { Octokit } from "@octokit/core";
import { generateAICompletion } from "@/lib/ai-client";
import {
  fetchGitGuardIgnore,
  checkIsIgnored,
  logIgnoredFindingToFirestore,
  type GitGuardIgnoreRule,
} from "@/lib/gitguard-ignore";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BugSeverity = "critical" | "high" | "medium" | "low";
export type BugConfidence = "high" | "medium" | "low";

export interface BugFinding {
  file: string;
  line: number;
  severity: BugSeverity;
  message: string;
  category?: "null_dereference" | "unhandled_promise" | "race_condition" | "off_by_one";
  confidence?: BugConfidence;
  suggestedChange?: string; // Exact replacement code line(s) for GitHub ```suggestion blocks
  originalCode?: string; // The buggy line(s) being replaced
}

export interface ChangedHunk {
  file: string;
  startLine: number;
  endLine: number;
  hunkHeader: string;
  diffText: string;
  addedLinesCount: number;
}

export interface RunBugScanOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  sha: string;
  diff: string;
  pullNumber?: number;
  installationId?: string | number;
  ignoreRules?: GitGuardIgnoreRule[];
}

// ── System Prompt (Strictly Bug-Scoped) ────────────────────────────────────────

const BUG_ANALYSIS_SYSTEM_PROMPT = `You are an elite code correctness and static analysis auditor.
Your job is to inspect CHANGED CODE HUNKS from git diffs and identify ONLY REAL SOFTWARE DEFECTS in the modified code.

STRICTLY ALLOWED BUG CATEGORIES (AND NOTHING ELSE):
1. Null / Undefined Dereferences:
   - Accessing properties or calling functions on values that can be null or undefined without validation or optional chaining.
   - Using uninitialized variables.
2. Unhandled Promises & Async Errors:
   - Floating asynchronous promises without 'await', '.catch()', or error boundary where an error can lead to unhandled rejections or silent drops.
   - Missing error handling in critical async operations.
3. Race Conditions:
   - Asynchronous check-then-act hazards (TOCTOU).
   - Unsynchronized concurrent mutation of shared variables.
   - Out-of-order execution bugs.
4. Off-by-One Errors:
   - Loop boundary conditions (< vs <=, index bounds mismatches).
   - Array/string slice, substring, or buffer index bounds errors.

STRICT PROHIBITIONS (DO NOT FLAG):
- Do NOT flag ANY stylistic preferences, formatting, variable naming, linting rules, or code organization.
- Do NOT flag missing comments, docstrings, or missing TypeScript types.
- Do NOT flag hypothetical issues if surrounding code or framework conventions guarantee safety.
- Only analyze the ADDED / CHANGED lines (lines starting with +) in the provided hunks.
- If no bugs match the 4 categories, return an empty array [].

CONFIDENCE & SUGGESTED REPLACEMENTS:
- "confidence": "high" | "medium" | "low".
- For "high" confidence findings, you MUST provide "suggestedReplacement" with the exact 1-to-few replacement lines of code to fix the defect (do NOT include markdown code fences or backticks in suggestedReplacement, just the clean replacement code).
- Also provide "originalCode" containing the original code line(s) being replaced.

SEVERITY THRESHOLDS:
- "critical": Definite runtime crash, fatal uncaught exception, or data corruption in normal execution.
- "high": Likely runtime failure or unhandled rejection under common user inputs or network failures.
- "medium": Potential race condition or null deref under specific edge-case timings/states.
- "low": Minor boundary edge case or unhandled promise where runtime impact is benign.

OUTPUT SCHEMA:
Return ONLY a valid JSON object with a "bugs" array matching this exact schema:
{
  "bugs": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "critical" | "high" | "medium" | "low",
      "confidence": "high" | "medium" | "low",
      "category": "null_dereference" | "unhandled_promise" | "race_condition" | "off_by_one",
      "message": "Concise, precise explanation of the bug and how to fix it.",
      "originalCode": "user.profile.name",
      "suggestedReplacement": "user?.profile?.name"
    }
  ]
}`;

// ── 1. Hunk Extractor (Only Changed Hunks, Not Full Files) ─────────────────────

const IGNORED_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".pdf",
  ".lock", "-lock.json", ".lockb", ".min.js", ".min.css", ".map"
];

function shouldInspectFile(filename: string): boolean {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  if (lower.includes("package-lock.json") || lower.includes("pnpm-lock.yaml") || lower.includes("yarn.lock")) {
    return false;
  }
  return !IGNORED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Extracts ONLY the changed hunks (not the full files) from a unified diff.
 */
export function extractChangedHunks(diff: string): ChangedHunk[] {
  if (!diff || !diff.trim()) return [];

  const hunks: ChangedHunk[] = [];
  const lines = diff.split("\n");

  let currentFile = "";
  let currentHunkLines: string[] = [];
  let hunkStartLine = 0;
  let hunkHeader = "";
  let addedLinesCount = 0;

  function flushCurrentHunk() {
    if (currentFile && currentHunkLines.length > 0 && addedLinesCount > 0) {
      hunks.push({
        file: currentFile,
        startLine: hunkStartLine,
        endLine: hunkStartLine + currentHunkLines.length,
        hunkHeader,
        diffText: currentHunkLines.join("\n"),
        addedLinesCount,
      });
    }
    currentHunkLines = [];
    addedLinesCount = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      flushCurrentHunk();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentFile = match ? match[2] : "";
    } else if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
    } else if (line.startsWith("@@ ")) {
      flushCurrentHunk();
      if (!shouldInspectFile(currentFile)) continue;

      hunkHeader = line;
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      hunkStartLine = match ? parseInt(match[1], 10) : 1;
      currentHunkLines.push(line);
    } else if (currentHunkLines.length > 0) {
      if (!shouldInspectFile(currentFile)) continue;

      currentHunkLines.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) {
        addedLinesCount++;
      }
    }
  }

  flushCurrentHunk();
  return hunks;
}

// ── 2. AI Bug Detection (Groq + Gemini Fallback) ───────────────────────────────

export async function detectBugsInHunks(
  hunks: ChangedHunk[]
): Promise<BugFinding[]> {
  if (hunks.length === 0) return [];

  // Group hunks by file to keep diff context coherent
  const rawHunks = hunks
    .map(
      (h) =>
        `File: ${h.file}\nHunk: ${h.hunkHeader}\n\`\`\`diff\n${h.diffText}\n\`\`\``
    )
    .join("\n\n---\n\n");

  // Safety cap at 24KB to prevent 413 / rate limit errors on giant multi-file diffs
  const MAX_DIFF_CHARS = 24_000;
  const formattedHunks =
    rawHunks.length > MAX_DIFF_CHARS
      ? rawHunks.slice(0, MAX_DIFF_CHARS) +
        "\n\n[Notice: Large commit diff truncated to first 24KB of hunks for model context]"
      : rawHunks;

  const userPrompt = `Analyze the following changed code hunks for null dereferences, unhandled promises, race conditions, and off-by-one errors:\n\n${formattedHunks}\n\nReturn JSON: { "bugs": [{ "file", "line", "severity", "confidence", "category", "message", "originalCode", "suggestedReplacement" }] }`;

  const rawCompletion = await generateAICompletion({
    messages: [
      { role: "system", content: BUG_ANALYSIS_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    jsonMode: true,
  });

  if (!rawCompletion) {
    console.log(`[bug-agent] No AI response returned for bug analysis.`);
    return [];
  }

  try {
    const cleanJson = rawCompletion.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(cleanJson);
    const rawBugs = Array.isArray(parsed) ? parsed : parsed.bugs || [];

    const validSeverities: BugSeverity[] = ["critical", "high", "medium", "low"];

    return rawBugs
      .filter((b: Record<string, unknown>) => b && typeof b.file === "string")
      .map((b: Record<string, unknown>) => {
        const sev = String(b.severity).toLowerCase();
        const severity: BugSeverity = validSeverities.includes(sev as BugSeverity)
          ? (sev as BugSeverity)
          : "medium";

        const conf = String(b.confidence || "").toLowerCase();
        const confidence: BugConfidence =
          conf === "high" || conf === "medium" || conf === "low"
            ? conf
            : severity === "critical" || severity === "high"
            ? "high"
            : "medium";

        // Clean up suggestion text if wrapped in markdown
        let suggested = typeof b.suggestedReplacement === "string" ? b.suggestedReplacement : undefined;
        if (!suggested && typeof b.suggestedChange === "string") {
          suggested = b.suggestedChange;
        }
        if (suggested) {
          suggested = suggested
            .replace(/^```[a-z]*\n?/i, "")
            .replace(/\n?```$/i, "")
            .trim();
        }

        return {
          file: String(b.file),
          line: Number(b.line) || 1,
          severity,
          confidence,
          category: b.category as BugFinding["category"],
          message: String(b.message || "Potential bug detected"),
          originalCode: typeof b.originalCode === "string" ? b.originalCode : undefined,
          suggestedChange: suggested || undefined,
        };
      });
  } catch (err) {
    console.warn(`[bug-agent] Failed to parse AI bug response:`, rawCompletion);
    return [];
  }
}

// ── 3. GitHub Suggested Change Publisher ──────────────────────────────────────

/**
 * Posts high-confidence bug findings as GitHub suggested changes directly onto the PR.
 * GitHub native ```suggestion blocks enable repository maintainers to apply and commit
 * the fix in one click from the PR interface.
 */
export async function postBugSuggestedChanges({
  octokit,
  owner,
  repo,
  sha,
  pullNumber,
  bugs,
}: {
  octokit: Octokit;
  owner: string;
  repo: string;
  sha: string;
  pullNumber?: number;
  bugs: BugFinding[];
}): Promise<{ postedCount: number; errors: string[] }> {
  const highConfidenceBugs = bugs.filter(
    (b) =>
      (b.confidence === "high" || b.severity === "critical" || b.severity === "high") &&
      Boolean(b.suggestedChange && b.suggestedChange.trim().length > 0)
  );

  if (highConfidenceBugs.length === 0) {
    return { postedCount: 0, errors: [] };
  }

  // Resolve target PR number if not provided directly
  let targetPr = pullNumber;
  if (!targetPr) {
    try {
      const prsResp = await octokit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", {
        owner,
        repo,
        commit_sha: sha,
      });
      if (Array.isArray(prsResp.data) && prsResp.data.length > 0) {
        targetPr = prsResp.data[0].number;
      }
    } catch {
      // Commit might not be part of open PR
    }
  }

  let postedCount = 0;
  const errors: string[] = [];

  if (targetPr) {
    for (const bug of highConfidenceBugs) {
      try {
        const suggestionBody = `### 🤖 GitGuard BugAgent Suggestion (${bug.severity.toUpperCase()})\n${bug.message}\n\n\`\`\`suggestion\n${bug.suggestedChange?.trim()}\n\`\`\``;

        await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments", {
          owner,
          repo,
          pull_number: targetPr,
          commit_id: sha,
          path: bug.file,
          line: bug.line,
          side: "RIGHT",
          body: suggestionBody,
        });

        postedCount++;
        console.log(
          `[bug-agent] Posted GitHub suggested change for ${bug.file}:${bug.line} on PR #${targetPr}`
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[bug-agent] Notice: inline PR suggestion on ${bug.file}:${bug.line}: ${msg}`);
        errors.push(`${bug.file}:${bug.line} - ${msg}`);
      }
    }
  }

  return { postedCount, errors };
}

// ── 4. Check Run Creation ("GitGuard / Bugs") ──────────────────────────────────

/**
 * Runs the Bug Agent scan:
 *  1. Extracts changed hunks.
 *  2. Evaluates hunks with Groq (Gemini fallback).
 *  3. Applies .gitguardignore parsing (skipping whitelisted files/lines and logging reasons).
 *  4. For high-confidence findings, posts GitHub suggested changes (```suggestion).
 *  5. Posts "GitGuard / Bugs" Check Run with annotations only for non-high-confidence findings.
 */
export async function runBugScan({
  octokit,
  owner,
  repo,
  sha,
  diff,
  pullNumber,
  installationId,
  ignoreRules,
}: RunBugScanOptions): Promise<{
  passed: boolean;
  isWarning: boolean;
  bugs: BugFinding[];
  ignoredCount: number;
  suggestionsPosted: number;
}> {
  console.log(`[bug-agent] Running bug scan for ${owner}/${repo} @ ${sha.slice(0, 7)}`);

  const hunks = extractChangedHunks(diff);
  console.log(`[bug-agent] Extracted ${hunks.length} changed code hunk(s)`);

  if (hunks.length === 0) {
    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: "GitGuard / Bugs",
      head_sha: sha,
      status: "completed",
      conclusion: "success",
      output: {
        title: "No code changes to analyze",
        summary: "Changeset contains no inspectable code hunks.",
      },
    });
    return { passed: true, isWarning: false, bugs: [], ignoredCount: 0, suggestionsPosted: 0 };
  }

  const rawBugs = await detectBugsInHunks(hunks);
  console.log(`[bug-agent] AI identified ${rawBugs.length} raw bug finding(s)`);

  // Load and apply .gitguardignore rules
  const rules = ignoreRules || (await fetchGitGuardIgnore(octokit, owner, repo, sha));
  const activeBugs: BugFinding[] = [];
  let ignoredCount = 0;

  for (const bug of rawBugs) {
    const ignoreCheck = checkIsIgnored(bug.file, rules);
    if (ignoreCheck.ignored && ignoreCheck.rule && ignoreCheck.rule.valid) {
      ignoredCount++;
      console.log(
        `[bug-agent] Skipping whitelisted finding in ${bug.file}:${bug.line} (Pattern: ${ignoreCheck.rule.pattern}, Reason: ${ignoreCheck.rule.reason})`
      );

      await logIgnoredFindingToFirestore({
        installationId: installationId || "0",
        repo: `${owner}/${repo}`,
        sha,
        file: bug.file,
        line: bug.line,
        agent: "BugAgent",
        rulePattern: ignoreCheck.rule.pattern,
        reason: ignoreCheck.rule.reason,
        findingSummary: `[${bug.severity.toUpperCase()}] ${bug.message}`,
        timestamp: Date.now(),
      });
      continue;
    }
    activeBugs.push(bug);
  }

  if (ignoredCount > 0) {
    console.log(`[bug-agent] .gitguardignore whitelisted ${ignoredCount} bug finding(s).`);
  }

  // Partition high-confidence findings with code suggestions vs other findings
  const highConfidenceBugs = activeBugs.filter(
    (b) =>
      (b.confidence === "high" || b.severity === "critical" || b.severity === "high") &&
      Boolean(b.suggestedChange && b.suggestedChange.trim().length > 0)
  );
  // Other findings that will receive plain annotations
  const annotationBugs = activeBugs.filter((b) => !highConfidenceBugs.includes(b));

  // Post high-confidence findings as GitHub suggested changes
  let suggestionsPosted = 0;
  if (highConfidenceBugs.length > 0) {
    const res = await postBugSuggestedChanges({
      octokit,
      owner,
      repo,
      sha,
      pullNumber,
      bugs: highConfidenceBugs,
    });
    suggestionsPosted = res.postedCount;
  }

  const failingBugs = activeBugs.filter((b) => b.severity === "critical" || b.severity === "high");
  const warningBugs = activeBugs.filter((b) => b.severity === "medium" || b.severity === "low");

  const hasFailingBugs = failingBugs.length > 0;
  const hasOnlyWarnings = !hasFailingBugs && warningBugs.length > 0;
  const isClean = activeBugs.length === 0;

  const checkName = "GitGuard / Bugs";

  if (isClean) {
    const summary =
      ignoredCount > 0
        ? `GitGuard bug scan passed. (Note: ${ignoredCount} finding(s) whitelisted by .gitguardignore).`
        : "GitGuard bug scan passed. No null dereferences, unhandled promises, race conditions, or off-by-one errors detected in changed hunks.";

    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: checkName,
      head_sha: sha,
      status: "completed",
      conclusion: "success",
      output: {
        title: "No bugs detected",
        summary,
      },
    });
    console.log(`[bug-agent] Posted SUCCESS check run for ${owner}/${repo}`);
  } else if (hasFailingBugs) {
    // High-confidence bugs are posted as suggested changes instead of plain annotations
    const annotations = annotationBugs.map((bug) => ({
      path: bug.file,
      start_line: bug.line,
      end_line: bug.line,
      annotation_level:
        bug.severity === "critical" || bug.severity === "high"
          ? ("failure" as const)
          : ("warning" as const),
      title: `${bug.severity.toUpperCase()}: Bug Detected`,
      message: bug.message,
    }));

    const markdownList = activeBugs
      .map((b) => `- **[${b.severity.toUpperCase()}] \`${b.file}:${b.line}\`**: ${b.message}`)
      .join("\n");

    const suggestedBlocks = highConfidenceBugs
      .map(
        (b) =>
          `#### 💡 \`${b.file}:${b.line}\` (${b.severity.toUpperCase()})\n${b.message}\n\`\`\`suggestion\n${b.suggestedChange}\n\`\`\``
      )
      .join("\n\n");

    const summary = [
      `### ❌ Bug(s) Exceeded Failure Threshold`,
      `GitGuard found **${failingBugs.length}** critical/high severity bug(s) that must be addressed:`,
      markdownList,
      highConfidenceBugs.length > 0
        ? `\n### 💡 High-Confidence Suggested Changes\nGitGuard converted high-confidence findings into one-click GitHub suggested changes:\n\n${suggestedBlocks}`
        : "",
      ignoredCount > 0
        ? `\n> 🛡️ **.gitguardignore**: ${ignoredCount} finding(s) were whitelisted and audited.`
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
        title: `${failingBugs.length} critical/high bug(s) detected`,
        summary,
        annotations: annotations.slice(0, 50),
      },
    });
    console.log(`[bug-agent] Posted FAILURE check run for ${owner}/${repo}`);
  } else {
    // Warnings only (below threshold) -> conclusion: "neutral"
    const annotations = annotationBugs.map((bug) => ({
      path: bug.file,
      start_line: bug.line,
      end_line: bug.line,
      annotation_level: "warning" as const,
      title: `${bug.severity.toUpperCase()}: Potential Issue`,
      message: bug.message,
    }));

    const markdownList = warningBugs
      .map((b) => `- **[${b.severity.toUpperCase()}] \`${b.file}:${b.line}\`**: ${b.message}`)
      .join("\n");

    const suggestedBlocks = highConfidenceBugs
      .map(
        (b) =>
          `#### 💡 \`${b.file}:${b.line}\`\n${b.message}\n\`\`\`suggestion\n${b.suggestedChange}\n\`\`\``
      )
      .join("\n\n");

    const summary = [
      `### ⚠️ Notice: Bug Warnings Below Fail Threshold`,
      `GitGuard detected **${warningBugs.length}** potential issue(s) of medium/low severity. These are posted as warnings and do not fail the check:`,
      markdownList,
      highConfidenceBugs.length > 0
        ? `\n### 💡 Suggested Changes\n${suggestedBlocks}`
        : "",
      ignoredCount > 0
        ? `\n> 🛡️ **.gitguardignore**: ${ignoredCount} finding(s) were whitelisted and audited.`
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
      conclusion: "neutral",
      output: {
        title: `${warningBugs.length} warning(s) detected (below fail threshold)`,
        summary,
        annotations: annotations.slice(0, 50),
      },
    });
    console.log(`[bug-agent] Posted NEUTRAL warning check run for ${owner}/${repo}`);
  }

  return {
    passed: !hasFailingBugs,
    isWarning: hasOnlyWarnings,
    bugs: activeBugs,
    ignoredCount,
    suggestionsPosted,
  };
}
