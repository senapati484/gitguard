/**
 * agents/email-agent.ts
 *
 * GitGuard Email Alert Agent.
 *
 * Responsibilities:
 *   - On BLOCK or WARN verdicts from LangGraph, dispatches a rich, structured
 *     HTML email alert via Nodemailer to the repository/installation's configured recipients.
 *   - Pulls alert settings (recipients, notification thresholds) from Firestore.
 *   - Provides clear, actionable remediation guidance ("One Clear Next Action")
 *     for each secret leak, critical/high bug, or security vulnerability.
 *   - Includes direct clickable GitHub links (file + line numbers) for immediate triage.
 *   - Fallback to NEXT_PUBLIC_SMTP_EMAIL / SMTP_EMAIL when custom recipients are unset.
 */

import nodemailer from "nodemailer";
import { adminDb } from "@/lib/firebase-admin";
import type { SecretVerificationResult } from "@/agents/secret-agent";
import type { BugFinding } from "@/agents/bug-agent";
import type { SecurityFinding } from "@/agents/security-agent";

// ── 1. Types & Interfaces ─────────────────────────────────────────────────────

export interface AlertSettings {
  installationId: string | number;
  alertEmail?: string; // Comma-separated or single email address
  notifyOnBlock?: boolean; // Defaults to true
  notifyOnWarn?: boolean; // Defaults to true
  notifyOnPass?: boolean; // Defaults to false
  slackWebhookUrl?: string; // Optional Slack incoming webhook URL
  updatedAt?: number;
  createdAt?: number;
}

export interface VerdictAlertPayload {
  installationId: string | number;
  repo: string;
  sha: string;
  decision: "BLOCK" | "WARN" | "PASS";
  pullNumber?: number;
  event?: string;
  summary?: string;
  prComment?: string;
  secretFindings?: SecretVerificationResult[];
  bugFindings?: BugFinding[];
  securityFindings?: SecurityFinding[];
  diffUrl?: string;
  autoSolved?: boolean;
  autoSolvedCommitSha?: string;
  autoSolvedFiles?: string[];
  branch?: string;
}

export interface ActionableFinding {

  type: "secret" | "bug" | "security";
  severity: "critical" | "high" | "medium" | "low";
  file: string;
  line: number;
  fileUrl: string;
  title: string;
  description: string;
  nextAction: string;
  originalCode?: string;
  suggestedChange?: string;
}

// ── 2. Nodemailer Transporter ─────────────────────────────────────────────────

function getSmtpTransporter() {
  const user =
    process.env.SMTP_EMAIL ||
    process.env.NEXT_PUBLIC_SMTP_EMAIL ||
    "developersayan01@gmail.com";
  const pass =
    process.env.SMTP_PASS ||
    process.env.NEXT_PUBLIC_SMTP_PASS ||
    "auwppecnthaxgkgh";

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: user.trim(),
      pass: pass.trim(),
    },
  });
}

// ── 3. Firestore Alert Settings Management ────────────────────────────────────

/**
 * Retrieves alert settings for an installation from Firestore.
 * Falls back to sensible defaults with the system SMTP email if not explicitly configured.
 */
export async function getAlertSettings(
  installationId: string | number
): Promise<AlertSettings> {
  const defaultEmail =
    process.env.SMTP_EMAIL ||
    process.env.NEXT_PUBLIC_SMTP_EMAIL ||
    "developersayan01@gmail.com";

  const defaultSettings: AlertSettings = {
    installationId: String(installationId),
    alertEmail: defaultEmail,
    notifyOnBlock: true,
    notifyOnWarn: true,
    notifyOnPass: false,
    updatedAt: Date.now(),
  };

  try {
    const docRef = adminDb.collection("alert_settings").doc(String(installationId));
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      const data = docSnap.data() as Partial<AlertSettings>;
      return {
        ...defaultSettings,
        ...data,
        installationId: String(installationId),
        alertEmail: data.alertEmail?.trim() || defaultEmail,
      };
    }

    // Secondary check: look under installations/{installationId}
    const installRef = adminDb.collection("installations").doc(String(installationId));
    const installSnap = await installRef.get();
    if (installSnap.exists) {
      const data = installSnap.data() as Record<string, unknown>;
      const email =
        typeof data.alertEmail === "string" && data.alertEmail.trim()
          ? data.alertEmail.trim()
          : defaultEmail;
      const slackWebhookUrl =
        typeof data.slackWebhookUrl === "string" ? data.slackWebhookUrl.trim() : undefined;

      return {
        ...defaultSettings,
        alertEmail: email,
        slackWebhookUrl,
      };
    }

    return defaultSettings;
  } catch (err) {
    console.warn(
      `[email-agent] Could not retrieve alert settings for ${installationId} from Firestore:`,
      err
    );
    return defaultSettings;
  }
}

/**
 * Persists updated alert settings for an installation to Firestore.
 */
export async function saveAlertSettings(
  settings: AlertSettings
): Promise<AlertSettings> {
  const installIdStr = String(settings.installationId);
  const toSave: AlertSettings = {
    installationId: installIdStr,
    alertEmail: settings.alertEmail?.trim() || "",
    notifyOnBlock: settings.notifyOnBlock ?? true,
    notifyOnWarn: settings.notifyOnWarn ?? true,
    notifyOnPass: settings.notifyOnPass ?? false,
    slackWebhookUrl: settings.slackWebhookUrl?.trim() || "",
    updatedAt: Date.now(),
  };

  await adminDb.collection("alert_settings").doc(installIdStr).set(toSave, { merge: true });
  console.log(`[email-agent] Saved alert settings for installation ${installIdStr} to Firestore`);
  return toSave;
}

// ── 4. One Clear Next Action Synthesis ────────────────────────────────────────

/**
 * Maps each flagged finding into a structured item with a direct GitHub URL
 * and a concrete, unambiguous next action.
 */
export function resolveActionableFindings(
  payload: VerdictAlertPayload
): ActionableFinding[] {
  const { repo, sha, secretFindings = [], bugFindings = [], securityFindings = [] } = payload;
  const items: ActionableFinding[] = [];

  const makeFileUrl = (file: string, line: number): string =>
    `https://github.com/${repo}/blob/${sha}/${file}#L${line}`;

  // 1. Confirmed Secrets (Always Critical)
  for (const s of secretFindings) {
    if (!s.confirmed) continue;
    const file = s.file || "unknown";
    const line = s.line || 1;
    items.push({
      type: "secret",
      severity: "critical",
      file,
      line,
      fileUrl: makeFileUrl(file, line),
      title: `Secret Leak: Detected in ${file}`,
      description: s.reason || "High-entropy secret or API key exposed in commit diff.",
      nextAction:
        "Immediately revoke and rotate this credential in your provider console. Remove it from git history using `git filter-repo` or BFG Repo-Cleaner, and inject it as a GitHub Secret / environment variable instead.",
    });
  }

  // 2. Bug Findings (Scoped to null derefs, unhandled promises, race conditions, off-by-ones)
  for (const b of bugFindings) {
    const file = b.file || "unknown";
    const line = b.line || 1;
    let nextAction = `Review ${file}:${line} and apply defensive boundary checks before merging.`;

    switch (b.category) {
      case "null_dereference":
        nextAction = `Add an optional chaining operator (?.) or defensive null/undefined guard before referencing properties at line ${line}.`;
        break;
      case "unhandled_promise":
        nextAction = `Wrap the asynchronous call at line ${line} in a try/catch block or chain a .catch(...) handler to prevent unhandled rejections.`;
        break;
      case "race_condition":
        nextAction = `Synchronize shared state access at line ${line} using an atomic transaction, mutex lock, or serial execution queue.`;
        break;
      case "off_by_one":
        nextAction = `Adjust boundary condition at line ${line} (e.g. verify < vs <= or index offset) to prevent out-of-bounds indexing.`;
        break;
    }

    items.push({
      type: "bug",
      severity: b.severity || "medium",
      file,
      line,
      fileUrl: makeFileUrl(file, line),
      title: `Bug (${b.category || "logic"}): ${b.message.slice(0, 70)}`,
      description: b.message,
      nextAction,
      originalCode: b.originalCode,
      suggestedChange: b.suggestedChange,
    });
  }

  // 3. Security Findings (OWASP / Semgrep / Exploitability)
  for (const s of securityFindings) {
    const file = s.file || "unknown";
    const line = s.line || 1;
    let nextAction = s.recommendation || `Remediate ${s.ruleId || "vulnerability"} according to OWASP guidelines before approving.`;

    const lowerRule = (s.ruleId || "").toLowerCase();
    const lowerDesc = (s.description || "").toLowerCase();

    if (!s.recommendation) {
      if (lowerRule.includes("sql") || lowerDesc.includes("sql")) {
        nextAction = `Use parameterized queries or prepared statements; avoid string concatenation in SQL expressions at line ${line}.`;
      } else if (lowerRule.includes("xss") || lowerDesc.includes("xss")) {
        nextAction = `Sanitize and encode all dynamic output before rendering to prevent Cross-Site Scripting at line ${line}.`;
      } else if (lowerRule.includes("command") || lowerRule.includes("exec") || lowerDesc.includes("command")) {
        nextAction = `Do not execute unsanitized input via shell; pass arguments as fixed arrays to execFile or spawn without shell: true.`;
      } else if (s.exploitabilityAssessment) {
        nextAction = `Exploitability risk detected: ${s.exploitabilityAssessment.slice(0, 160)}. Fix root cause at line ${line}.`;
      }
    }

    items.push({
      type: "security",
      severity: s.severity || "medium",
      file,
      line,
      fileUrl: makeFileUrl(file, line),
      title: `Security (${s.ruleId || "Vulnerability"}): ${s.description.slice(0, 70)}`,
      description: s.exploitabilityAssessment
        ? `${s.description} (Exploitability: ${s.exploitabilityAssessment})`
        : s.description,
      nextAction,
    });
  }

  return items;
}

function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function buildAlertEmailHtml(
  payload: VerdictAlertPayload,
  findings: ActionableFinding[],
  recipient: string
): string {
  const { repo, sha, decision, pullNumber, event, autoSolved, autoSolvedCommitSha, branch } = payload;
  const isBlock = decision === "BLOCK";
  const shortSha = sha.slice(0, 7);
  const targetBranch = branch || "main";

  const statusBadge = autoSolved && autoSolvedCommitSha
    ? `<span style="display: inline-block; background: #059669; color: #ffffff; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">✔ AUTO-SOLVED &amp; PUSHED</span>`
    : isBlock
    ? `<span style="display: inline-block; background: #000000; color: #ffffff; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">● BLOCK</span>`
    : decision === "WARN"
    ? `<span style="display: inline-block; background: #ffffff; color: #000000; border: 1.5px solid #000000; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">▲ WARN</span>`
    : `<span style="display: inline-block; background: #f5f5f5; color: #171717; border: 1px solid #e5e5e5; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;">✔ PASS</span>`;

  const prOrCommitUrl = pullNumber
    ? `https://github.com/${repo}/pull/${pullNumber}`
    : autoSolvedCommitSha
    ? `https://github.com/${repo}/commit/${autoSolvedCommitSha}`
    : `https://github.com/${repo}/commit/${sha}`;

  const findingsHtml = findings
    .map((f, idx) => {
      const sevBadge =
        f.severity === "critical"
          ? `<span style="display: inline-block; background: #000000; color: #ffffff; padding: 2px 7px; border-radius: 3px; font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;">CRITICAL</span>`
          : f.severity === "high"
          ? `<span style="display: inline-block; background: #262626; color: #ffffff; padding: 2px 7px; border-radius: 3px; font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;">HIGH</span>`
          : f.severity === "medium"
          ? `<span style="display: inline-block; background: #e5e5e5; color: #171717; padding: 2px 7px; border-radius: 3px; font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;">MEDIUM</span>`
          : `<span style="display: inline-block; background: #f5f5f5; color: #525252; padding: 2px 7px; border-radius: 3px; font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;">LOW</span>`;

      const codeFixHtml = f.suggestedChange
        ? `
          <div style="margin-top: 12px; background: #090d16; border: 1px solid #1e293b; border-radius: 6px; padding: 12px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; color: #f8fafc; overflow-x: auto;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <span style="font-size: 10px; text-transform: uppercase; color: ${autoSolvedCommitSha ? "#4ade80" : "#94a3b8"}; font-weight: 700; letter-spacing: 0.06em;">
                ${autoSolvedCommitSha ? "⚡ Applied &amp; Pushed to GitHub by GitGuard [bot]" : "⚡ Verified Auto-Solve Fix"}
              </span>
              ${
                autoSolvedCommitSha
                  ? `<a href="https://github.com/${repo}/commit/${autoSolvedCommitSha}" style="font-size: 10px; color: #38bdf8; text-decoration: underline;" target="_blank">commit: ${autoSolvedCommitSha.slice(0, 7)} ↗</a>`
                  : ""
              }
            </div>
            ${
              f.originalCode
                ? `<div style="color: #f87171; background: rgba(239,68,68,0.1); padding: 3px 6px; border-radius: 3px; margin-bottom: 4px; white-space: pre-wrap; font-family: ui-monospace, monospace;">- ${escapeHtml(f.originalCode)}</div>`
                : ""
            }
            <div style="color: #4ade80; background: rgba(34,197,94,0.1); padding: 3px 6px; border-radius: 3px; white-space: pre-wrap; font-weight: 500; font-family: ui-monospace, monospace;">+ ${escapeHtml(f.suggestedChange)}</div>
          </div>
        `
        : "";

      const remediationHtml = autoSolved && autoSolvedCommitSha
        ? `<span style="color: #059669; font-weight: 600;">✅ Clean fix autonomously applied and pushed to GitHub as <strong>GitGuard [bot]</strong> in commit <a href="https://github.com/${repo}/commit/${autoSolvedCommitSha}" style="color: #059669; text-decoration: underline;" target="_blank">${autoSolvedCommitSha.slice(0, 7)}</a>. Branch <code>${escapeHtml(targetBranch)}</code> is now completely clean and passing. No manual action required!</span>`
        : escapeHtml(f.nextAction);

      return `
        <div style="border: 1px solid #e5e5e5; border-radius: 8px; margin-bottom: 16px; background-color: #ffffff; overflow: hidden;">
          <!-- Card Header Table -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #fafafa; border-bottom: 1px solid #e5e5e5;">
            <tr>
              <td style="padding: 10px 14px; font-size: 12px; font-weight: 600; color: #0a0a0a;">
                <span style="color: #737373; margin-right: 6px;">#${idx + 1}</span>
                ${sevBadge}
                <span style="margin-left: 8px; color: #171717;">${escapeHtml(f.title)}</span>
              </td>
              <td align="right" style="padding: 10px 14px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap;">
                <a href="${f.fileUrl}" style="color: #000000; text-decoration: underline; font-weight: 600;" target="_blank">
                  ${escapeHtml(f.file)}:${f.line} ↗
                </a>
              </td>
            </tr>
          </table>

          <!-- Card Body -->
          <div style="padding: 16px 14px;">
            <div style="font-size: 13px; color: #262626; line-height: 1.55; margin-bottom: 10px;">
              ${escapeHtml(f.description)}
            </div>

            ${codeFixHtml}

            <!-- Remediation Action Callout -->
            <div style="margin-top: 12px; background: ${autoSolved ? "#f0fdf4" : "#fafafa"}; border-left: 3px solid ${autoSolved ? "#059669" : "#000000"}; padding: 10px 12px; font-size: 12px; color: #171717; line-height: 1.55;">
              <span style="font-weight: 700; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; color: ${autoSolved ? "#059669" : "#525252"}; display: block; margin-bottom: 2px;">
                ${autoSolved ? "Autonomous Remediation Status" : "Remediation Step"}
              </span>
              ${remediationHtml}
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  const bannerTitle = autoSolved && autoSolvedCommitSha
    ? "Defects Autonomously Solved &amp; Pushed to GitHub"
    : isBlock
    ? "Merge Blocked — Critical Defects Detected"
    : "Review Recommended — Quality Regressions Detected";

  const bannerSubtitle = autoSolved && autoSolvedCommitSha
    ? `GitGuard detected defects on commit <code>${shortSha}</code>, automatically applied clean fixes, committed as <strong>GitGuard [bot]</strong>, and pushed commit <a href="https://github.com/${repo}/commit/${autoSolvedCommitSha}" style="color: #059669; font-weight: 700; text-decoration: underline;" target="_blank"><code>${autoSolvedCommitSha.slice(0, 7)}</code></a> directly to branch <strong>${escapeHtml(targetBranch)}</strong>.`
    : `Automated verification for repository <strong style="color: #000000;">${repo}</strong> on ${event || "push"} event.`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitGuard Alert: ${autoSolved ? "AUTO-SOLVED" : decision} for ${repo}</title>
</head>
<body style="margin: 0; padding: 24px 12px; background-color: #fafafa; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0a0a0a;">
  <div style="max-width: 620px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; border: 1px solid #e5e5e5; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
    
    <!-- Top Nav Header -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding: 16px 20px; border-bottom: 1px solid #e5e5e5; background: #ffffff;">
      <tr>
        <td align="left" style="vertical-align: middle;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="vertical-align: middle; padding-right: 10px;">
                <div style="width: 26px; height: 26px; border-radius: 6px; background-color: #000000; text-align: center; line-height: 26px; display: inline-block;">
                  <span style="color: #ffffff; font-size: 13px; font-weight: 800;">🛡</span>
                </div>
              </td>
              <td style="vertical-align: middle;">
                <span style="font-size: 15px; font-weight: 800; letter-spacing: -0.01em; color: #000000;">GitGuard</span>
                <span style="font-size: 11px; margin-left: 6px; padding: 2px 6px; border-radius: 4px; background: #f5f5f5; border: 1px solid #e5e5e5; color: #525252; font-family: ui-monospace, monospace;">v1.2</span>
              </td>
            </tr>
          </table>
        </td>
        <td align="right" style="vertical-align: middle;">
          <a href="${prOrCommitUrl}" style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; background: #f5f5f5; border: 1px solid #e5e5e5; padding: 4px 8px; border-radius: 4px; color: #171717; text-decoration: none;" target="_blank">
            ${autoSolvedCommitSha ? `clean: ${autoSolvedCommitSha.slice(0, 7)}` : pullNumber ? `PR #${pullNumber}` : `sha: ${shortSha}`} ↗
          </a>
        </td>
      </tr>
    </table>

    <!-- Verdict Banner -->
    <div style="padding: 24px 20px; border-bottom: 1px solid #e5e5e5; background: #ffffff;">
      <div style="margin-bottom: 12px;">
        ${statusBadge}
      </div>
      <h1 style="margin: 0 0 8px 0; font-size: 19px; font-weight: 700; color: #000000; letter-spacing: -0.02em; line-height: 1.3;">
        ${bannerTitle}
      </h1>
      <p style="margin: 0; font-size: 13px; color: #525252; line-height: 1.5;">
        ${bannerSubtitle}
      </p>
    </div>

    <!-- 3-Column Metrics Bar -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #fafafa; border-bottom: 1px solid #e5e5e5;">
      <tr>
        <td style="padding: 14px 18px; border-right: 1px solid #e5e5e5; width: 33.33%;">
          <div style="font-size: 10px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em; color: #737373; margin-bottom: 4px;">Status</div>
          <div style="font-size: 13px; font-weight: 700; color: ${autoSolved ? "#059669" : "#000000"};">${autoSolved ? "PASS (Auto-Solved)" : decision}</div>
        </td>
        <td style="padding: 14px 18px; border-right: 1px solid #e5e5e5; width: 33.33%;">
          <div style="font-size: 10px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em; color: #737373; margin-bottom: 4px;">Resolved Items</div>
          <div style="font-size: 13px; font-weight: 700; color: #000000;">${findings.length} defect${findings.length === 1 ? "" : "s"}</div>
        </td>
        <td style="padding: 14px 18px; width: 33.33%;">
          <div style="font-size: 10px; text-transform: uppercase; font-weight: 700; letter-spacing: 0.05em; color: #737373; margin-bottom: 4px;">Target Ref</div>
          <div style="font-size: 13px; font-weight: 600; font-family: ui-monospace, monospace; color: #000000;">
            <a href="${prOrCommitUrl}" style="color: #000000; text-decoration: underline;" target="_blank">
              ${autoSolvedCommitSha ? autoSolvedCommitSha.slice(0, 7) : pullNumber ? `PR #${pullNumber}` : shortSha}
            </a>
          </div>
        </td>
    </table>

    <!-- Findings Section -->
    <div style="padding: 24px 20px;">
      <h2 style="margin: 0 0 16px 0; font-size: 13px; font-weight: 700; color: #000000; text-transform: uppercase; letter-spacing: 0.05em;">
        Actionable Defects &amp; Code Solutions
      </h2>

      ${
        findings.length > 0
          ? findingsHtml
          : `<div style="padding: 16px; background-color: #fafafa; border: 1px solid #e5e5e5; border-radius: 6px; color: #737373; font-size: 13px; line-height: 1.5;">
               ${escapeHtml(payload.summary || "No individual code lines were flagged, but review thresholds triggered this alert.")}
             </div>`
      }

      <!-- Primary Action CTA -->
      <div style="margin-top: 24px; text-align: center;">
        <a href="${prOrCommitUrl}" style="display: inline-block; background-color: #000000; color: #ffffff; padding: 12px 28px; border-radius: 6px; font-size: 13px; font-weight: 600; text-decoration: none; letter-spacing: 0.01em;" target="_blank">
          View &amp; Triage on GitHub ↗
        </a>
      </div>
    </div>

    <!-- Footer -->
    <div style="background-color: #fafafa; padding: 16px 20px; border-top: 1px solid #e5e5e5; font-size: 11px; color: #737373; line-height: 1.5;">
      <div>
        Automated security verification dispatched to <strong>${recipient}</strong> for installation <code>${payload.installationId}</code>.
      </div>
      <div style="margin-top: 4px;">
        To manage notification thresholds or recipients, visit your 
        <a href="${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/dashboard/settings" style="color: #000000; text-decoration: underline;">GitGuard Settings</a>.
      </div>
    </div>

  </div>
</body>
</html>
  `;
}

export function buildAlertEmailText(
  payload: VerdictAlertPayload,
  findings: ActionableFinding[]
): string {
  const { repo, sha, decision, pullNumber } = payload;
  const prOrCommitUrl = pullNumber
    ? `https://github.com/${repo}/pull/${pullNumber}`
    : `https://github.com/${repo}/commit/${sha}`;

  let out = `[GitGuard Alert] Verdict: ${decision} for ${repo}\n`;
  out += `Reference: ${prOrCommitUrl}\n`;
  out += `Commit SHA: ${sha}\n\n`;
  out += `Flagged Findings (${findings.length}):\n`;
  out += `=================================================\n\n`;

  findings.forEach((f, idx) => {
    out += `${idx + 1}. [${f.severity.toUpperCase()}] ${f.title}\n`;
    out += `   File: ${f.file}:${f.line}\n`;
    out += `   URL: ${f.fileUrl}\n`;
    out += `   Details: ${f.description}\n`;
    out += `   NEXT ACTION: ${f.nextAction}\n\n`;
  });

  out += `Triage now at: ${prOrCommitUrl}\n`;
  return out;
}

// ── 6. Main Email Alert Dispatcher ────────────────────────────────────────────

export interface EmailAlertResult {
  sent: boolean;
  recipients: string[];
  messageId?: string;
  reason?: string;
}

/**
 * Sends a high-priority email alert when a pull request or commit produces a BLOCK or WARN verdict.
 */
export async function sendVerdictEmailAlert(
  payload: VerdictAlertPayload
): Promise<EmailAlertResult> {
  const { installationId, repo, decision, sha } = payload;

  console.log(
    `[email-agent] Evaluating alert criteria for ${repo} (verdict: ${decision}, installation: ${installationId})...`
  );

  // 1. Fetch configured alert settings from Firestore
  const settings = await getAlertSettings(installationId);

  // 2. Check if notification is enabled for this verdict
  if (decision === "BLOCK" && settings.notifyOnBlock === false) {
    console.log(`[email-agent] BLOCK notifications disabled in settings for ${installationId}`);
    return { sent: false, recipients: [], reason: "Disabled in settings" };
  }
  if (decision === "WARN" && settings.notifyOnWarn === false) {
    console.log(`[email-agent] WARN notifications disabled in settings for ${installationId}`);
    return { sent: false, recipients: [], reason: "Disabled in settings" };
  }
  if (decision === "PASS" && !settings.notifyOnPass) {
    return { sent: false, recipients: [], reason: "Pass notifications not requested" };
  }

  // 3. Resolve recipient list
  const recipientRaw =
    settings.alertEmail ||
    process.env.SMTP_EMAIL ||
    process.env.NEXT_PUBLIC_SMTP_EMAIL ||
    "developersayan01@gmail.com";

  const recipients = recipientRaw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0 && e.includes("@"));

  if (recipients.length === 0) {
    console.warn(`[email-agent] No valid recipient email addresses found for ${installationId}`);
    return { sent: false, recipients: [], reason: "No valid recipient emails" };
  }

  // 4. Resolve structured findings with one clear next action each
  const findings = resolveActionableFindings(payload);

  // 5. Compose email subject & body
  const shortSha = sha.slice(0, 7);
  const emoji = decision === "BLOCK" ? "🚨" : "⚠️";
  const subject = `${emoji} [${decision}] GitGuard Alert: ${repo} (${shortSha})`;

  const senderEmail =
    process.env.SMTP_EMAIL ||
    process.env.NEXT_PUBLIC_SMTP_EMAIL ||
    "developersayan01@gmail.com";

  const transporter = getSmtpTransporter();
  const htmlContent = buildAlertEmailHtml(payload, findings, recipients.join(", "));
  const textContent = buildAlertEmailText(payload, findings);

  try {
    const info = await transporter.sendMail({
      from: `"GitGuard Security" <${senderEmail}>`,
      to: recipients.join(", "),
      subject,
      text: textContent,
      html: htmlContent,
      headers: {
        "X-GitGuard-Verdict": decision,
        "X-GitGuard-Repo": repo,
        "X-GitGuard-Sha": sha,
        "X-GitGuard-Installation": String(installationId),
      },
    });

    console.log(
      `[email-agent] ✅ Alert email sent successfully to [${recipients.join(", ")}] (MessageId: ${info.messageId})`
    );

    // Optional: Log alert event to Firestore "alert_history"
    await adminDb
      .collection("alert_history")
      .add({
        installationId: String(installationId),
        repo,
        sha,
        decision,
        recipients,
        messageId: info.messageId,
        findingsCount: findings.length,
        sentAt: Date.now(),
      })
      .catch((err) => {
        console.warn(`[email-agent] Could not record alert history:`, err.message);
      });

    return {
      sent: true,
      recipients,
      messageId: info.messageId,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[email-agent] ❌ Failed to dispatch email alert:`, errorMsg);
    return {
      sent: false,
      recipients,
      reason: errorMsg,
    };
  }
}

/**
 * Sends a test alert email to verify SMTP configuration and recipient delivery.
 */
export async function sendTestAlertEmail(
  toEmail: string,
  installationId: string | number
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const dummyPayload: VerdictAlertPayload = {
    installationId,
    repo: "example-org/sample-repo",
    sha: "a1b2c3d4e5f67890123456789abcdef012345678",
    decision: "BLOCK",
    pullNumber: 42,
    event: "pull_request",
    secretFindings: [
      {
        file: "src/config/aws.ts",
        line: 14,
        confirmed: true,
        reason: "Active AWS Access Key ID detected in client code bundle.",
      },
    ],
    bugFindings: [
      {
        file: "src/services/billing.ts",
        line: 88,
        severity: "critical",
        category: "null_dereference",
        message: "userProfile.subscription accessed without verifying userProfile existence.",
      },
    ],
    securityFindings: [
      {
        file: "src/api/search.ts",
        line: 32,
        ruleId: "owasp.a03.sql-injection",
        severity: "high",
        description: "Dynamic query parameter interpolated directly into SQL template.",
        recommendation: "Use parameterized queries or prepared statements instead of string interpolation.",
        source: "semgrep",
        isExploitable: true,
        exploitabilityAssessment: "Attacker controlled query string can alter WHERE clause logic.",
      },
    ],
  };

  const findings = resolveActionableFindings(dummyPayload);
  const transporter = getSmtpTransporter();
  const senderEmail =
    process.env.SMTP_EMAIL ||
    process.env.NEXT_PUBLIC_SMTP_EMAIL ||
    "developersayan01@gmail.com";

  try {
    const info = await transporter.sendMail({
      from: `"GitGuard Security" <${senderEmail}>`,
      to: toEmail.trim(),
      subject: `🧪 [TEST] GitGuard Alert System Verification (Installation ${installationId})`,
      text: buildAlertEmailText(dummyPayload, findings),
      html: buildAlertEmailHtml(dummyPayload, findings, toEmail),
    });

    return { success: true, messageId: info.messageId };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
