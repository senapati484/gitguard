/**
 * lib/gitguard-ignore.ts
 *
 * .gitguardignore parser, glob matcher, and audit tracer.
 *
 * Rules:
 *   - Each rule must specify a glob pattern AND a required reason string.
 *   - Format: `<glob-pattern> # reason: <reason text>`
 *     e.g. `tests/fixtures/** # reason: mock test data with dummy API keys`
 *          `*.mock.ts # reason: local unit test stubs`
 *   - Lines lacking a reason string are marked invalid and will NOT whitelist files.
 *   - Whenever SecretAgent or BugAgent skips a finding because of a valid rule,
 *     the event is recorded to Firestore (`ignored_audits`) to be surfaced in
 *     the Dashboard Audit View.
 */

import type { Octokit } from "@octokit/core";
import { adminDb } from "@/lib/firebase-admin";

export interface GitGuardIgnoreRule {
  pattern: string;
  reason: string;
  lineNumber: number;
  valid: boolean;
  error?: string;
  regex: RegExp;
}

export interface IgnoredAuditRecord {
  id?: string;
  installationId: string | number;
  repo: string;
  sha: string;
  file: string;
  line?: number;
  agent: "SecretAgent" | "BugAgent" | "SecurityAgent" | "SEOAgent";
  rulePattern: string;
  reason: string;
  findingSummary: string;
  timestamp: number;
}

/**
 * Converts a glob pattern (e.g. `tests/**\/*.ts`, `*.mock.js`) into a safe RegExp.
 */
export function globToRegExp(glob: string): RegExp {
  let normalized = glob.trim().replace(/^\/+/, "");

  // Escape special regex chars except * and ?
  let regexStr = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*\\/)?") // **/ matches zero or more directories
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");

  // If pattern does not start with wildcard or relative slash, match across paths or from root
  if (!glob.startsWith("/")) {
    regexStr = `(?:^|\\/)${regexStr}`;
  } else {
    regexStr = `^${regexStr}`;
  }

  return new RegExp(`${regexStr}$`, "i");
}

/**
 * Parses raw .gitguardignore content into validated rules.
 * Requires each active rule to include a non-empty reason string.
 */
export function parseGitGuardIgnore(content: string): GitGuardIgnoreRule[] {
  const rules: GitGuardIgnoreRule[] = [];
  if (!content || !content.trim()) return rules;

  const lines = content.split("\n");

  lines.forEach((rawLine, idx) => {
    const lineNum = idx + 1;
    const trimmed = rawLine.trim();

    // Skip empty lines and full comment lines without pattern
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
      return;
    }

    // Expected format: <pattern> # reason: <reason text>
    // Also supports: <pattern> // reason: <reason text> or <pattern> --reason="<text>"
    const reasonMatch =
      trimmed.match(/(?:#|\/\/)\s*(?:reason|why)\s*[:=]\s*(.+)$/i) ||
      trimmed.match(/--reason=["']([^"']+)["']/i);

    let patternPart = trimmed;
    let reasonText = "";

    if (reasonMatch) {
      patternPart = trimmed.slice(0, reasonMatch.index).trim();
      reasonText = (reasonMatch[1] || "").trim();
    } else {
      // Check if line contains a comment at all
      const commentIdx = trimmed.search(/[#\/]/);
      if (commentIdx !== -1) {
        patternPart = trimmed.slice(0, commentIdx).trim();
      }
    }

    if (!patternPart) return;

    if (!reasonText || reasonText.length < 3) {
      // Rule lacks the mandatory reason string
      rules.push({
        pattern: patternPart,
        reason: "",
        lineNumber: lineNum,
        valid: false,
        error: "Missing required reason string (format: pattern # reason: <why it is ignored>)",
        regex: globToRegExp(patternPart),
      });
      return;
    }

    try {
      const regex = globToRegExp(patternPart);
      rules.push({
        pattern: patternPart,
        reason: reasonText,
        lineNumber: lineNum,
        valid: true,
        regex,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      rules.push({
        pattern: patternPart,
        reason: reasonText,
        lineNumber: lineNum,
        valid: false,
        error: `Invalid glob regex: ${msg}`,
        regex: /^$/,
      });
    }
  });

  return rules;
}

/**
 * Checks whether a given file path is whitelisted by a valid .gitguardignore rule.
 */
export function checkIsIgnored(
  filePath: string,
  rules: GitGuardIgnoreRule[]
): { ignored: boolean; rule?: GitGuardIgnoreRule } {
  const normalizedPath = filePath.replace(/^\/+/, "").replace(/\\/g, "/");

  for (const rule of rules) {
    if (!rule.valid) continue;
    if (rule.regex.test(normalizedPath)) {
      return { ignored: true, rule };
    }
  }

  return { ignored: false };
}

/**
 * Attempts to fetch .gitguardignore from the repository root via GitHub Octokit.
 * Falls back to empty rule set if file does not exist.
 */
export async function fetchGitGuardIgnore(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref?: string
): Promise<GitGuardIgnoreRule[]> {
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path: ".gitguardignore",
      ref,
    });

    if ("content" in res.data && typeof res.data.content === "string") {
      const rawText = Buffer.from(res.data.content, "base64").toString("utf-8");
      console.log(`[gitguard-ignore] Loaded .gitguardignore from ${owner}/${repo}`);
      return parseGitGuardIgnore(rawText);
    }
  } catch (err: unknown) {
    // 404 is normal if repo does not have .gitguardignore
    const status = (err as { status?: number })?.status;
    if (status !== 404) {
      console.warn(`[gitguard-ignore] Could not fetch .gitguardignore from ${owner}/${repo}:`, err);
    }
  }

  // Fallback: check if Firestore repository settings store whitelisted rules
  try {
    const repoDoc = await adminDb.collection("repo_settings").doc(`${owner}__${repo}`).get();
    if (repoDoc.exists) {
      const data = repoDoc.data();
      if (typeof data?.gitguardignoreContent === "string") {
        return parseGitGuardIgnore(data.gitguardignoreContent);
      }
    }
  } catch {
    // Ignore Firestore lookup error
  }

  return [];
}

/**
 * Records an ignored finding event to Firestore for transparency in the Dashboard Audit View.
 */
export async function logIgnoredFindingToFirestore(
  record: IgnoredAuditRecord
): Promise<void> {
  try {
    await adminDb.collection("ignored_audits").add({
      ...record,
      timestamp: record.timestamp || Date.now(),
    });
    console.log(
      `[gitguard-ignore] Logged whitelisted ${record.agent} finding in ${record.file} (Reason: ${record.reason})`
    );
  } catch (err) {
    console.warn(`[gitguard-ignore] Failed to log ignored audit to Firestore:`, err);
  }
}

/**
 * Retrieves historical ignored / whitelisted findings from Firestore.
 */
export async function getIgnoredAuditRecords(
  installationId?: string | number,
  repo?: string,
  limitCount: number = 50
): Promise<IgnoredAuditRecord[]> {
  try {
    let query: FirebaseFirestore.Query = adminDb.collection("ignored_audits");

    if (installationId) {
      query = query.where("installationId", "in", [String(installationId), Number(installationId)]);
    }
    if (repo) {
      query = query.where("repo", "==", repo.trim().toLowerCase());
    }

    const snapshot = await query.orderBy("timestamp", "desc").limit(limitCount).get().catch((err) => {
      // Fallback without composite index
      console.warn(`[gitguard-ignore] Timestamp index notice, fetching without sort:`, err.message);
      return query.limit(limitCount).get();
    });

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...(doc.data() as Omit<IgnoredAuditRecord, "id">),
    }));
  } catch (err) {
    console.warn(`[gitguard-ignore] Failed to fetch ignored audit records:`, err);
    return [];
  }
}
