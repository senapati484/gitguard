/**
 * agents/security-agent.ts
 *
 * Security Vulnerability Agent for GitGuard.
 *
 * Focus:
 *   Static application security analysis (SAST) on changed hunks for OWASP Top 10 vulnerabilities:
 *   - Injection (SQL, Command, Shell, LDAP, Template)
 *   - SSRF (Server-Side Request Forgery)
 *   - Path Traversal / Arbitrary File Access
 *   - Insecure Deserialization & Prototype Pollution
 *   - Broken Access Control / Insecure Direct Object References
 *   - Insecure Cryptography & Weak Randomness
 *   - Cross-Site Scripting (XSS)
 *
 * Note: Secret leakage is handled separately by SecretAgent.
 */

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
}

export interface RunSecurityScanOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  sha: string;
  diff: string;
}

// ── System Prompt ─────────────────────────────────────────────────────────────

const SECURITY_ANALYSIS_SYSTEM_PROMPT = `You are a Principal Application Security Engineer and Penetration Tester.
Your job is to inspect CHANGED CODE HUNKS from git diffs and identify ONLY REAL APPLICATION SECURITY VULNERABILITIES.

IN-SCOPE SECURITY VULNERABILITY CLASSES:
1. Injection Vulnerabilities:
   - SQL / NoSQL Injection (unparameterized queries, string interpolation into raw queries)
   - Command / Shell Injection (exec, execSync, spawn with unsanitized user input)
   - Cross-Site Scripting (XSS) in frontend/HTML rendering
2. Server-Side Request Forgery (SSRF):
   - Outbound HTTP requests (fetch, axios, http.request) fetching arbitrary user-controlled URLs without allowlist/validation.
3. Path Traversal & Unrestricted File Operations:
   - Unsanitized file path manipulation leading to directory traversal (e.g. path.join with user input).
4. Insecure Deserialization & Prototype Pollution:
   - Object recursive merging or unsafe deserialization.
5. Insecure Cryptography & Authorization Flaws:
   - Weak hashing (MD5/SHA1 for passwords), hardcoded IVs, math.random for tokens/crypto, missing authorization checks.

STRICT EXCLUSIONS (DO NOT FLAG):
- Do NOT flag API keys or secrets (handled by a dedicated secret scanner).
- Do NOT flag generic bugs (like null dereferences or off-by-one errors) unless they directly induce a security exploit.
- Do NOT flag stylistic, lint, or code quality opinions.
- If no security vulnerabilities exist, return an empty array [].

SEVERITY CRITERIA:
- "critical": Remotely exploitable RCE, unauthenticated SQLi, or direct SSRF to cloud metadata.
- "high": Authenticated injection, stored XSS, or arbitrary local file read.
- "medium": Potential SSRF with restrictions, reflected XSS, or insecure cryptographic primitive.
- "low": Defense-in-depth security hardening issue.

OUTPUT FORMAT:
Return ONLY a valid JSON object matching:
{
  "vulnerabilities": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "critical" | "high" | "medium" | "low",
      "ruleId": "sql-injection" | "ssrf" | "command-injection" | "path-traversal" | "xss" | "crypto-weakness",
      "description": "Clear explanation of the exploit vector.",
      "recommendation": "Exact remediation steps or code fix."
    }
  ]
}`;

// ── 1. Vulnerability Detection ────────────────────────────────────────────────

export async function detectSecurityVulnerabilities(
  hunks: ChangedHunk[]
): Promise<SecurityFinding[]> {
  if (hunks.length === 0) return [];

  const formattedHunks = hunks
    .map(
      (h) =>
        `File: ${h.file}\nHunk: ${h.hunkHeader}\n\`\`\`diff\n${h.diffText}\n\`\`\``
    )
    .join("\n\n---\n\n");

  const userPrompt = `Analyze the following changed code hunks for OWASP Top 10 application security vulnerabilities:\n\n${formattedHunks}\n\nReturn JSON: { "vulnerabilities": [{ "file", "line", "severity", "ruleId", "description", "recommendation" }] }`;

  const rawCompletion = await generateAICompletion({
    messages: [
      { role: "system", content: SECURITY_ANALYSIS_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    jsonMode: true,
  });

  if (!rawCompletion) return [];

  try {
    const cleanJson = rawCompletion.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(cleanJson);
    const rawList = Array.isArray(parsed) ? parsed : parsed.vulnerabilities || [];

    const validSeverities: SecuritySeverity[] = ["critical", "high", "medium", "low"];

    return rawList
      .filter((v: Record<string, unknown>) => v && typeof v.file === "string")
      .map((v: Record<string, unknown>) => {
        const sev = String(v.severity).toLowerCase();
        const severity: SecuritySeverity = validSeverities.includes(sev as SecuritySeverity)
          ? (sev as SecuritySeverity)
          : "medium";

        return {
          file: String(v.file),
          line: Number(v.line) || 1,
          severity,
          ruleId: String(v.ruleId || "security-vulnerability"),
          description: String(v.description || "Potential security issue detected"),
          recommendation: String(v.recommendation || "Review and sanitize input"),
        };
      });
  } catch (err) {
    console.warn(`[security-agent] Failed to parse security findings:`, rawCompletion);
    return [];
  }
}

// ── 2. Run Scan & Check Run ───────────────────────────────────────────────────

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
  console.log(`[security-agent] Scanning ${owner}/${repo} @ ${sha.slice(0, 7)} for security vulnerabilities...`);

  const hunks = extractChangedHunks(diff);
  if (hunks.length === 0) {
    return { passed: true, findings: [] };
  }

  const findings = await detectSecurityVulnerabilities(hunks);
  console.log(`[security-agent] Identified ${findings.length} security vulnerability finding(s)`);

  const criticalOrHigh = findings.filter(
    (f) => f.severity === "critical" || f.severity === "high"
  );
  const passed = criticalOrHigh.length === 0;

  // Post Check Run "GitGuard / Security"
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
        summary: "GitGuard security analysis passed. No injection, SSRF, path traversal, or OWASP vulnerabilities detected in changed hunks.",
      },
    });
  } else if (!passed) {
    const annotations = findings.map((f) => ({
      path: f.file,
      start_line: f.line,
      end_line: f.line,
      annotation_level:
        f.severity === "critical" || f.severity === "high"
          ? ("failure" as const)
          : ("warning" as const),
      title: `${f.severity.toUpperCase()}: ${f.ruleId}`,
      message: `${f.description}\nRecommendation: ${f.recommendation}`,
    }));

    const markdownList = findings
      .map(
        (f) =>
          `- **[${f.severity.toUpperCase()}] \`${f.file}:${f.line}\`** (${f.ruleId}): ${f.description}\n  *Fix:* ${f.recommendation}`
      )
      .join("\n");

    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: checkName,
      head_sha: sha,
      status: "completed",
      conclusion: "failure",
      output: {
        title: `${criticalOrHigh.length} security vulnerability(ies) detected`,
        summary: `### 🛡️ Security Vulnerabilities Detected\n\n${markdownList}`,
        annotations: annotations.slice(0, 50),
      },
    });
  } else {
    // Only medium/low -> neutral
    const annotations = findings.map((f) => ({
      path: f.file,
      start_line: f.line,
      end_line: f.line,
      annotation_level: "warning" as const,
      title: `${f.severity.toUpperCase()}: ${f.ruleId}`,
      message: `${f.description}\nRecommendation: ${f.recommendation}`,
    }));

    const markdownList = findings
      .map(
        (f) =>
          `- **[${f.severity.toUpperCase()}] \`${f.file}:${f.line}\`** (${f.ruleId}): ${f.description}`
      )
      .join("\n");

    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: checkName,
      head_sha: sha,
      status: "completed",
      conclusion: "neutral",
      output: {
        title: `${findings.length} security warning(s) detected (below fail threshold)`,
        summary: `### ⚠️ Security Warnings (Below Fail Threshold)\n\n${markdownList}`,
        annotations: annotations.slice(0, 50),
      },
    });
  }

  return { passed, findings };
}
