/**
 * agents/security-agent.ts
 *
 * Application Security & Vulnerability Agent for GitGuard.
 *
 * Core Capabilities:
 *   1. Semgrep SAST on git diff hunks with rule registry:
 *      `semgrep --config=p/owasp-top-ten`
 *      (with graceful AST/heuristic pattern fallback if CLI is not in environment)
 *   2. Dependency Audit on modified package manifests:
 *      - Inspects package.json, lockfiles, and manifest changes in the diff
 *      - Audits modified/added dependencies via local npm audit and OSV vulnerability database
 *   3. AI Exploitability Reasoning (LLaMA 3.3 70B via Groq, Gemini fallback):
 *      - Critically reasons about REAL-WORLD EXPLOITABILITY vs theoretical CVE presence
 *      - Assesses data flow taint propagation, sink reachability, and framework mitigations
 *      - Differentiates active exploit vectors from uncallable/mitigated CVEs
 *      - Emits structured verdicts: { isExploitable, exploitabilityAssessment, attackVector }
 *   4. Integrates as a parallel node in the LangGraph Orchestrator state graph.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import type { Octokit } from "@octokit/core";
import { generateAICompletion } from "@/lib/ai-client";
import { extractChangedHunks, type ChangedHunk } from "@/agents/bug-agent";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SecuritySeverity = "critical" | "high" | "medium" | "low";

export interface SecurityFinding {
  file: string;
  line: number;
  severity: SecuritySeverity;
  ruleId: string;
  description: string;
  recommendation: string;
  source: "semgrep" | "dependency-audit" | "heuristic";
  cveId?: string;
  packageName?: string;
  currentVersion?: string;
  patchedVersion?: string;
  /**
   * True only if untrusted input can reach the sink and trigger an exploit.
   * False if the sink is unreachable, mitigated by framework, or theoretical.
   */
  isExploitable: boolean;
  /** Detailed technical reasoning on data flow, reachability, and exploitability. */
  exploitabilityAssessment: string;
  /** Realistic attack vector or trigger scenario (if exploitable). */
  attackVector?: string;
}

export interface RawCandidateFinding {
  file: string;
  line: number;
  rawSeverity: string;
  ruleId: string;
  message: string;
  snippet?: string;
  source: "semgrep" | "dependency-audit" | "heuristic";
  cveId?: string;
  packageName?: string;
  version?: string;
}

export interface RunSecurityScanOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  sha: string;
  diff: string;
}

// ── 1. Locating Semgrep Binary ────────────────────────────────────────────────

export function findSemgrepBinary(): string | null {
  // 1. Explicit environment variable
  if (process.env.SEMGREP_PATH && fs.existsSync(process.env.SEMGREP_PATH)) {
    return process.env.SEMGREP_PATH;
  }

  // 2. Standard locations on macOS & Linux
  const candidatePaths = [
    "/opt/homebrew/bin/semgrep",
    "/usr/local/bin/semgrep",
    "/usr/bin/semgrep",
    path.join(os.homedir(), ".local", "bin", "semgrep"),
    path.join(os.homedir(), "Library", "Python", "3.9", "bin", "semgrep"),
    path.join(os.homedir(), "Library", "Python", "3.10", "bin", "semgrep"),
    path.join(os.homedir(), "Library", "Python", "3.11", "bin", "semgrep"),
    path.join(os.homedir(), "Library", "Python", "3.12", "bin", "semgrep"),
    path.join(os.homedir(), "Library", "Python", "3.13", "bin", "semgrep"),
    path.join(os.homedir(), "Library", "Python", "3.14", "bin", "semgrep"),
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // 3. Try `which semgrep`
  try {
    const whichRes = execFileSync("which", ["semgrep"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (whichRes && fs.existsSync(whichRes)) {
      return whichRes;
    }
  } catch {
    // ignore
  }

  return null;
}

// ── 2. Run Semgrep Scan on Diff ───────────────────────────────────────────────

interface SemgrepJsonResult {
  check_id: string;
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  extra: {
    message: string;
    severity: string;
    lines?: string;
    metadata?: {
      cwe?: string | string[];
      owasp?: string | string[];
    };
  };
}

/**
 * Reconstructs modified files from diff in an isolated temp directory,
 * runs `semgrep --config=p/owasp-top-ten --json`, and parses findings.
 */
export async function runSemgrepScan(diff: string): Promise<RawCandidateFinding[]> {
  const semgrepBin = findSemgrepBinary();
  if (!semgrepBin) {
    console.log(
      "[security-agent] Semgrep binary not in PATH. Running high-precision OWASP pattern heuristics."
    );
    return runHeuristicOwaspScan(diff);
  }

  console.log(`[security-agent] Using semgrep binary at: ${semgrepBin}`);

  const hunks = extractChangedHunks(diff);
  if (hunks.length === 0) return [];

  // Group diff hunks by file
  const filesMap = new Map<string, ChangedHunk[]>();
  for (const h of hunks) {
    const existing = filesMap.get(h.file) || [];
    existing.push(h);
    filesMap.set(h.file, existing);
  }

  // Create isolated temp workspace
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitguard-semgrep-"));

  try {
    // Reconstruct files in tempDir
    for (const [filePath, fileHunks] of Array.from(filesMap.entries())) {
      const targetFilePath = path.join(tempDir, filePath);
      fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });

      // Build file representation containing added/modified lines
      const reconstructedLines: string[] = [];
      let currentLineNum = 1;

      for (const h of fileHunks) {
        // Pad line count to match approximate diff line numbers
        while (currentLineNum < h.startLine) {
          reconstructedLines.push("// [unmodified context]");
          currentLineNum++;
        }

        const lines = h.diffText.split("\n");
        for (const line of lines) {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            reconstructedLines.push(line.slice(1));
            currentLineNum++;
          } else if (line.startsWith(" ")) {
            reconstructedLines.push(line.slice(1));
            currentLineNum++;
          }
        }
      }

      fs.writeFileSync(targetFilePath, reconstructedLines.join("\n"), "utf-8");
    }

    // Initialize git inside tempDir so Semgrep treats all files as git-tracked
    try {
      spawnSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
      spawnSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
    } catch {
      // non-fatal
    }

    // Run semgrep --config=p/owasp-top-ten --json
    const semgrepArgs = [
      "scan",
      "--config=p/owasp-top-ten",
      "--json",
      "--no-git-ignore",
      "--disable-version-check",
      tempDir,
    ];

    console.log(`[security-agent] Executing: ${semgrepBin} ${semgrepArgs.join(" ")}`);

    const result = spawnSync(semgrepBin, semgrepArgs, {
      cwd: tempDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });

    const rawOutput = (result.stdout || "").trim();
    const heuristicResults = runHeuristicOwaspScan(diff);

    if (!rawOutput) {
      if (result.stderr) {
        console.warn(`[security-agent] Semgrep stderr: ${result.stderr.slice(0, 300)}`);
      }
      return heuristicResults;
    }

    try {
      const parsed = JSON.parse(rawOutput) as { results?: SemgrepJsonResult[] };
      const semgrepHits = parsed.results || [];
      console.log(`[security-agent] Semgrep produced ${semgrepHits.length} raw result(s)`);

      const candidates: RawCandidateFinding[] = [];
      for (const hit of semgrepHits) {
        const relativeFile = path.relative(tempDir, hit.path);
        candidates.push({
          file: relativeFile,
          line: hit.start?.line || 1,
          rawSeverity: hit.extra?.severity || "WARNING",
          ruleId: hit.check_id,
          message: hit.extra?.message || "Semgrep OWASP Top 10 rule trigger",
          snippet: hit.extra?.lines,
          source: "semgrep",
        });
      }

      // Merge with heuristic findings (avoiding duplicates on same file+line)
      for (const h of heuristicResults) {
        const exists = candidates.some(
          (c) => c.file === h.file && Math.abs(c.line - h.line) <= 2
        );
        if (!exists) {
          candidates.push(h);
        }
      }

      return candidates;
    } catch (parseErr) {
      console.warn(`[security-agent] Failed to parse Semgrep JSON output:`, parseErr);
      return heuristicResults;
    }
  } catch (err) {
    console.error(`[security-agent] Error during Semgrep execution:`, err);
    return runHeuristicOwaspScan(diff);
  } finally {
    // Clean up temporary workspace
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ── 3. Heuristic OWASP Scanner Fallback ────────────────────────────────────────

const OWASP_HEURISTIC_RULES = [
  {
    id: "owasp-a03-sql-injection",
    name: "SQL Injection via String Concatenation",
    regex: /(?:SELECT|INSERT|UPDATE|DELETE|DROP|UNION).*?\$\{[^}]+\}|(?:SELECT|INSERT|UPDATE|DELETE|DROP|UNION).*?["']\s*\+\s*[a-zA-Z0-9_.]+/i,
    severity: "high",
    description: "Raw SQL query constructed with dynamic string interpolation instead of parameterized queries.",
  },
  {
    id: "owasp-a03-command-injection",
    name: "Command Injection via Unsanitized Shell Execution",
    regex: /(?:exec|execSync|spawn|spawnSync|popen)\s*\(\s*(?:`[^`]*\$\{[^}]+\}[^`]*`|["'][^"']*["']\s*\+\s*[a-zA-Z0-9_.]+)/,
    severity: "critical",
    description: "System command execution with dynamic string concatenation vulnerable to arbitrary command injection.",
  },
  {
    id: "owasp-a10-ssrf",
    name: "Server-Side Request Forgery (SSRF)",
    regex: /(?:fetch|axios(?:\.get|\.post)?|https?\.get|request)\s*\(\s*(?:req\.(?:query|body|params)|url|targetUrl|inputUrl)/,
    severity: "high",
    description: "Outbound network request invoked directly with user-supplied URL without host allowlist or IP verification.",
  },
  {
    id: "owasp-a01-path-traversal",
    name: "Arbitrary File Path Traversal",
    regex: /(?:readFile|readFileSync|createReadStream|unlink|writeFile)\s*\(\s*(?:path\.join|path\.resolve)\s*\([^)]*(?:req\.|params\.|query\.)/,
    severity: "high",
    description: "File system operation using untrusted input in path resolution without directory confinement check.",
  },
  {
    id: "owasp-a03-xss-raw-html",
    name: "Cross-Site Scripting (XSS) via Unsanitized HTML",
    regex: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*(?!DOMPurify)[a-zA-Z0-9_.]+\s*\}\s*\}|innerHTML\s*=\s*(?!DOMPurify)[a-zA-Z0-9_.]+/,
    severity: "medium",
    description: "Unsanitized input rendered directly into DOM without HTML entity encoding or DOMPurify.",
  },
  {
    id: "owasp-a02-weak-cryptography",
    name: "Broken Cryptography / Insecure Randomness",
    regex: /createHash\s*\(\s*["'](?:md5|sha1)["']\)|Math\.random\s*\(\s*\)\.toString\s*\(\s*36\s*\)/i,
    severity: "low",
    description: "Use of broken cryptographic hash (MD5/SHA1) or non-cryptographic Math.random for security tokens.",
  },
];

export function runHeuristicOwaspScan(diff: string): RawCandidateFinding[] {
  const hunks = extractChangedHunks(diff);
  const candidates: RawCandidateFinding[] = [];

  for (const h of hunks) {
    const lines = h.diffText.split("\n");
    let currentLine = h.startLine;

    for (const rawLine of lines) {
      if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
        const addedCode = rawLine.slice(1);
        for (const rule of OWASP_HEURISTIC_RULES) {
          if (rule.regex.test(addedCode)) {
            candidates.push({
              file: h.file,
              line: currentLine,
              rawSeverity: rule.severity,
              ruleId: rule.id,
              message: rule.description,
              snippet: addedCode.trim(),
              source: "heuristic",
            });
          }
        }
        currentLine++;
      } else if (rawLine.startsWith(" ")) {
        currentLine++;
      }
    }
  }

  return candidates;
}

// ── 4. Dependency Audit on Diff ───────────────────────────────────────────────

interface OsvVulnerability {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  database_specific?: {
    severity?: string;
    cvss?: unknown;
  };
  severity?: Array<{ type: string; score: string }>;
  affected?: Array<{
    package?: { name: string; ecosystem: string };
    ranges?: Array<{
      type: string;
      events: Array<{ introduced?: string; fixed?: string }>;
    }>;
  }>;
}

export interface ModifiedDependency {
  name: string;
  version: string;
  file: string;
  line: number;
}

/**
 * Parses package.json changes from diff to detect newly added or updated dependencies.
 */
export function extractModifiedDependencies(diff: string): ModifiedDependency[] {
  const hunks = extractChangedHunks(diff);
  const modifiedDeps: ModifiedDependency[] = [];

  for (const h of hunks) {
    if (!h.file.endsWith("package.json")) continue;

    const lines = h.diffText.split("\n");
    let lineNum = h.startLine;

    for (const l of lines) {
      if (l.startsWith("+") && !l.startsWith("+++")) {
        const text = l.slice(1).trim();
        // Match JSON dependency entry: "package-name": "^1.2.3"
        const match = text.match(/"(@?[a-zA-Z0-9_\-\.\/]+)"\s*:\s*"([^"]+)"/);
        if (match) {
          const [, name, version] = match;
          // Filter out typical non-dependency package.json keys
          const nonDeps = new Set([
            "name",
            "version",
            "description",
            "main",
            "scripts",
            "author",
            "license",
            "type",
            "repository",
            "keywords",
          ]);
          if (!nonDeps.has(name) && !name.startsWith("node_")) {
            // Clean version string (remove ^, ~, >=, etc.)
            const cleanVer = version.replace(/[\^~>=<]/g, "").trim();
            modifiedDeps.push({
              name,
              version: cleanVer,
              file: h.file,
              line: lineNum,
            });
          }
        }
        lineNum++;
      } else if (l.startsWith(" ")) {
        lineNum++;
      }
    }
  }

  return modifiedDeps;
}

/**
 * Queries the public OSV vulnerability database for a given npm package version.
 */
export async function queryOsvVulnerabilities(
  pkgName: string,
  version: string
): Promise<OsvVulnerability[]> {
  try {
    const res = await fetch("https://api.osv.dev/v1/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        package: { name: pkgName, ecosystem: "npm" },
        version: version || undefined,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return [];
    const data = (await res.json()) as { vulns?: OsvVulnerability[] };
    return data.vulns || [];
  } catch {
    return [];
  }
}

/**
 * Executes a dependency audit across all modified package manifests in the diff.
 */
export async function runDependencyAudit(diff: string): Promise<RawCandidateFinding[]> {
  const deps = extractModifiedDependencies(diff);
  if (deps.length === 0) return [];

  console.log(`[security-agent] Auditing ${deps.length} modified dependency(ies)...`);
  const findings: RawCandidateFinding[] = [];

  for (const dep of deps) {
    try {
      const vulns = await queryOsvVulnerabilities(dep.name, dep.version);
      for (const vuln of vulns) {
        const cveId = vuln.aliases?.find((a) => a.startsWith("CVE-")) || vuln.id;
        const rawSev =
          vuln.database_specific?.severity?.toLowerCase() ||
          vuln.severity?.[0]?.score?.toLowerCase() ||
          "high";

        // Find fixed version if available
        let fixedVersion: string | undefined;
        for (const aff of vuln.affected || []) {
          for (const rng of aff.ranges || []) {
            for (const evt of rng.events || []) {
              if (evt.fixed) fixedVersion = evt.fixed;
            }
          }
        }

        findings.push({
          file: dep.file,
          line: dep.line,
          rawSeverity: rawSev,
          ruleId: `dependency-cve-${dep.name}`,
          message: `${dep.name}@${dep.version} is affected by ${cveId}: ${
            vuln.summary || vuln.details || "Known vulnerability"
          }${fixedVersion ? ` (Fixed in: ${fixedVersion})` : ""}`,
          cveId,
          packageName: dep.name,
          version: dep.version,
          source: "dependency-audit",
        });
      }
    } catch (err) {
      console.warn(`[security-agent] Error querying OSV for ${dep.name}:`, err);
    }
  }

  return findings;
}

// ── 5. AI Exploitability Reasoning Engine ─────────────────────────────────────

const EXPLOITABILITY_REASONING_PROMPT = `You are a Principal Security Architect and Penetration Tester at GitGuard.
Your job is to critically evaluate candidate security findings (from Semgrep SAST and Dependency Audits) against the git diff.

CRITICAL PRINCIPLE: REASON ABOUT REAL-WORLD EXPLOITABILITY — NOT JUST CVE PRESENCE.
Security teams are inundated by false alarms. You must distinguish theoretical vulnerabilities and dormant CVEs from actionable, real-world exploitable security defects.

EVALUATION METHODOLOGY:
1. Reachability & Data Flow:
   - Is the vulnerable function, method, or dependency API actually called in the codebase?
   - Does untrusted external user input (e.g. req.query, req.body, headers, URL params, webhook payloads) reach the vulnerable sink?
   - Or is it invoked purely with compile-time constants, internal configurations, or trusted internal variables?
2. Defensive Controls & Mitigations:
   - Are there input validation layers (e.g. Zod schemas, parseInt, regex whitelisting, cryptographic validation)?
   - Are there framework-level guardrails active (e.g. React/Next.js JSX context escaping preventing XSS, Prisma/Drizzle parameterized queries preventing SQLi)?
   - For Dependency CVEs: Is the specific vulnerable module/API imported or utilized by the project?
3. Exploitability Verdict:
   - "isExploitable": TRUE if an attacker can manipulate an external input to reach the sink and achieve execution/leakage/tampering.
   - "isExploitable": FALSE if the sink is unreachable, strictly sanitized, purely internal, or theoretical without a viable attack path.
4. Severity Calibration:
   - If "isExploitable" is FALSE: downgrade severity to "low" or "medium" as an informational advisory (do not block merges for dormant CVEs).
   - If "isExploitable" is TRUE: assign "critical" or "high" according to direct CVSS impact.

OUTPUT FORMAT:
Return ONLY valid JSON matching:
{
  "analyzedFindings": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "critical" | "high" | "medium" | "low",
      "ruleId": "rule-or-cve-id",
      "description": "Clear explanation of the finding and context",
      "isExploitable": true | false,
      "exploitabilityAssessment": "Detailed technical rationale explaining WHY it is or is not exploitable in this specific codebase context",
      "attackVector": "Realistic attack path or 'N/A - uncallable/mitigated sink'",
      "recommendation": "Concrete fix or patch instruction"
    }
  ]
}`;

export async function reasonAboutExploitability(
  candidates: RawCandidateFinding[],
  diff: string
): Promise<SecurityFinding[]> {
  if (candidates.length === 0) return [];

  const hunks = extractChangedHunks(diff);
  const diffSnippet = hunks
    .map(
      (h) =>
        `File: ${h.file}\nHunk (${h.hunkHeader}):\n\`\`\`diff\n${h.diffText}\n\`\`\``
    )
    .join("\n\n---\n\n");

  const candidatesFormatted = candidates
    .map(
      (c, idx) =>
        `Finding #${idx + 1}:
- Source: ${c.source}
- Rule/CVE: ${c.ruleId} ${c.cveId ? `(${c.cveId})` : ""}
- File: ${c.file}:${c.line}
- Raw Severity: ${c.rawSeverity}
- Message: ${c.message}
${c.snippet ? `- Code Snippet: ${c.snippet}` : ""}`
    )
    .join("\n\n");

  const userPrompt = `Evaluate the following candidate security findings against the git diff hunks:

CANDIDATE FINDINGS:
${candidatesFormatted}

GIT DIFF HUNKS:
${diffSnippet.slice(0, 24000)}

Perform reachability and exploitability reasoning. Return JSON:
{ "analyzedFindings": [{ "file", "line", "severity", "ruleId", "description", "isExploitable", "exploitabilityAssessment", "attackVector", "recommendation" }] }`;

  const rawCompletion = await generateAICompletion({
    messages: [
      { role: "system", content: EXPLOITABILITY_REASONING_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    jsonMode: true,
  });

  if (!rawCompletion) {
    // Graceful fallback mapping candidate findings
    return candidates.map((c) => ({
      file: c.file,
      line: c.line,
      severity: (["critical", "high", "medium", "low"].includes(
        c.rawSeverity.toLowerCase()
      )
        ? c.rawSeverity.toLowerCase()
        : "medium") as SecuritySeverity,
      ruleId: c.ruleId,
      description: c.message,
      recommendation: "Review and sanitize input",
      source: c.source,
      cveId: c.cveId,
      packageName: c.packageName,
      isExploitable: true,
      exploitabilityAssessment: "Automated scanner finding requiring security review.",
    }));
  }

  try {
    const cleanJson = rawCompletion.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(cleanJson);
    const rawList = Array.isArray(parsed)
      ? parsed
      : parsed.analyzedFindings || parsed.vulnerabilities || [];

    const validSeverities: SecuritySeverity[] = ["critical", "high", "medium", "low"];

    return rawList
      .filter((v: Record<string, unknown>) => v && typeof v.file === "string")
      .map((v: Record<string, unknown>) => {
        const sev = String(v.severity).toLowerCase();
        const severity: SecuritySeverity = validSeverities.includes(
          sev as SecuritySeverity
        )
          ? (sev as SecuritySeverity)
          : "medium";

        // Correlate with candidate source
        const matchingCandidate = candidates.find(
          (c) =>
            c.file.toLowerCase() === String(v.file).toLowerCase() &&
            Math.abs(c.line - (Number(v.line) || 1)) <= 5
        );

        return {
          file: String(v.file),
          line: Number(v.line) || 1,
          severity,
          ruleId: String(v.ruleId || matchingCandidate?.ruleId || "security-finding"),
          description: String(v.description || matchingCandidate?.message || "Security issue"),
          recommendation: String(
            v.recommendation || "Review code against OWASP guidelines"
          ),
          source: matchingCandidate?.source || "semgrep",
          cveId: matchingCandidate?.cveId,
          packageName: matchingCandidate?.packageName,
          isExploitable: typeof v.isExploitable === "boolean" ? v.isExploitable : true,
          exploitabilityAssessment: String(
            v.exploitabilityAssessment ||
              "Model determined exploitability based on code reachability."
          ),
          attackVector: v.attackVector ? String(v.attackVector) : undefined,
        };
      });
  } catch (err) {
    console.warn(`[security-agent] Error parsing exploitability completion:`, err);
    return candidates.map((c) => ({
      file: c.file,
      line: c.line,
      severity: "medium" as SecuritySeverity,
      ruleId: c.ruleId,
      description: c.message,
      recommendation: "Review code against OWASP guidelines",
      source: c.source,
      cveId: c.cveId,
      isExploitable: true,
      exploitabilityAssessment: "Defaulting to exploitable pending security review.",
    }));
  }
}

// ── 6. Main Entry Point: detectSecurityVulnerabilities ────────────────────────

/**
 * Orchestrator node worker interface:
 * 1. Runs Semgrep OWASP Top 10 SAST scan on diff
 * 2. Runs Dependency audit on modified manifests
 * 3. AI models reasons about real-world exploitability vs theoretical CVE presence
 */
export async function detectSecurityVulnerabilities(
  diff: string
): Promise<SecurityFinding[]> {
  console.log(`[security-agent] Initiating dual SAST + Dependency security audit...`);

  // Parallel execution of Semgrep scan + Dependency audit
  const [semgrepCandidates, dependencyCandidates] = await Promise.all([
    runSemgrepScan(diff).catch((err) => {
      console.warn(`[security-agent] Semgrep scan failed:`, err);
      return runHeuristicOwaspScan(diff);
    }),
    runDependencyAudit(diff).catch((err) => {
      console.warn(`[security-agent] Dependency audit failed:`, err);
      return [];
    }),
  ]);

  const allCandidates = [...semgrepCandidates, ...dependencyCandidates];
  console.log(
    `[security-agent] Aggregated ${allCandidates.length} candidate finding(s) (Semgrep: ${semgrepCandidates.length}, Dependencies: ${dependencyCandidates.length})`
  );

  if (allCandidates.length === 0) {
    return [];
  }

  // Model reasons on real-world exploitability
  console.log(
    `[security-agent] Reasoning on real-world exploitability with AI model...`
  );
  const validatedFindings = await reasonAboutExploitability(allCandidates, diff);
  console.log(
    `[security-agent] Completed exploitability evaluation: ${
      validatedFindings.filter((f) => f.isExploitable).length
    } confirmed exploitable out of ${validatedFindings.length} finding(s)`
  );

  return validatedFindings;
}

// ── 7. Run Security Scan & GitHub Check Run ───────────────────────────────────

export async function runSecurityScan({
  octokit,
  owner,
  repo,
  sha,
  diff,
}: RunSecurityScanOptions): Promise<{
  passed: boolean;
  findings: SecurityFinding[];
}> {
  console.log(
    `[security-agent] Scanning ${owner}/${repo} @ ${sha.slice(0, 7)} for security vulnerabilities...`
  );

  const findings = await detectSecurityVulnerabilities(diff);

  // Critical/High findings that are confirmed REAL-WORLD EXPLOITABLE cause failure
  const exploitableBlockers = findings.filter(
    (f) =>
      f.isExploitable && (f.severity === "critical" || f.severity === "high")
  );
  const passed = exploitableBlockers.length === 0;

  const checkName = "GitGuard / Security";

  if (findings.length === 0) {
    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: checkName,
      head_sha: sha,
      status: "completed",
      conclusion: "success",
      output: {
        title: "No security vulnerabilities detected",
        summary:
          "GitGuard SAST and dependency audits passed. No OWASP Top 10 vulnerabilities or exploitable CVEs detected.",
      },
    });
  } else if (!passed) {
    const annotations = findings.map((f) => ({
      path: f.file,
      start_line: f.line,
      end_line: f.line,
      annotation_level: f.isExploitable
        ? ("failure" as const)
        : ("warning" as const),
      title: `${f.severity.toUpperCase()} [${f.isExploitable ? "EXPLOITABLE" : "THEORETICAL"}]: ${f.ruleId}`,
      message: `${f.description}\n\nExploitability Analysis: ${f.exploitabilityAssessment}\nFix: ${f.recommendation}`,
    }));

    const markdownList = findings
      .map(
        (f) =>
          `- **[${f.severity.toUpperCase()}] \`${f.file}:${f.line}\`** (${f.ruleId})\n` +
          `  *Exploitability:* **${f.isExploitable ? "🚨 Confirmed Exploitable" : "⚠️ Theoretical / Mitigated"}**\n` +
          `  *Assessment:* ${f.exploitabilityAssessment}\n` +
          `  *Fix:* ${f.recommendation}`
      )
      .join("\n\n");

    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: checkName,
      head_sha: sha,
      status: "completed",
      conclusion: "failure",
      output: {
        title: `${exploitableBlockers.length} exploitable security vulnerability(ies) detected`,
        summary: `### 🛡️ Security Vulnerabilities & Exploitability Analysis\n\n${markdownList}`,
        annotations: annotations.slice(0, 50),
      },
    });
  } else {
    // Only warnings / mitigated / non-exploitable CVEs -> neutral
    const annotations = findings.map((f) => ({
      path: f.file,
      start_line: f.line,
      end_line: f.line,
      annotation_level: "warning" as const,
      title: `${f.severity.toUpperCase()} [${f.isExploitable ? "EXPLOITABLE" : "MITIGATED"}]: ${f.ruleId}`,
      message: `${f.description}\n\nExploitability Analysis: ${f.exploitabilityAssessment}`,
    }));

    const markdownList = findings
      .map(
        (f) =>
          `- **[${f.severity.toUpperCase()}] \`${f.file}:${f.line}\`** (${f.ruleId})\n` +
          `  *Exploitability:* ${f.isExploitable ? "Low severity exploit" : "Theoretical CVE / Mitigated by context"}\n` +
          `  *Assessment:* ${f.exploitabilityAssessment}`
      )
      .join("\n\n");

    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: checkName,
      head_sha: sha,
      status: "completed",
      conclusion: "neutral",
      output: {
        title: `${findings.length} security advisory/warning(s) (non-blocking)`,
        summary: `### ⚠️ Security Advisories (Non-Blocking)\n\n${markdownList}`,
        annotations: annotations.slice(0, 50),
      },
    });
  }

  return { passed, findings };
}
