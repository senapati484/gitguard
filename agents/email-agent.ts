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

// ── 5. Responsive HTML & Text Email Templates ─────────────────────────────────

function buildAlertEmailHtml(
  payload: VerdictAlertPayload,
  findings: ActionableFinding[],
  recipient: string
): string {
  const { repo, sha, decision, pullNumber, event } = payload;
  const isBlock = decision === "BLOCK";
  const statusColor = isBlock ? "#dc2626" : "#d97706";
  const statusBg = isBlock ? "#fef2f2" : "#fffbeb";
  const statusBorder = isBlock ? "#f87171" : "#fcd34d";
  const statusEmoji = isBlock ? "🚨" : "⚠️";
  const shortSha = sha.slice(0, 7);

  const prOrCommitUrl = pullNumber
    ? `https://github.com/${repo}/pull/${pullNumber}`
    : `https://github.com/${repo}/commit/${sha}`;

  const findingsHtml = findings
    .map((f, idx) => {
      const sevColor =
        f.severity === "critical"
          ? "#dc2626"
          : f.severity === "high"
          ? "#ea580c"
          : f.severity === "medium"
          ? "#d97706"
          : "#2563eb";

      return `
        <div style="border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 16px; background-color: #ffffff; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
          <!-- Finding Header -->
          <div style="background-color: #f8fafc; padding: 12px 16px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between;">
            <div style="font-size: 13px; font-weight: 600; color: #1e293b;">
              #${idx + 1} &nbsp;
              <span style="display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #ffffff; background-color: ${sevColor};">
                ${f.severity}
              </span>
              &nbsp; ${f.title}
            </div>
            <div style="font-size: 12px; font-family: monospace;">
              <a href="${f.fileUrl}" style="color: #2563eb; text-decoration: underline; font-weight: 500;" target="_blank">
                ${f.file}:${f.line} ↗
              </a>
            </div>
          </div>

          <!-- Finding Body -->
          <div style="padding: 16px;">
            <div style="font-size: 13px; color: #475569; line-height: 1.5; margin-bottom: 12px;">
              <strong>Details:</strong> ${f.description}
            </div>

            <!-- One Clear Next Action -->
            <div style="background-color: #eff6ff; border-left: 4px solid #3b82f6; padding: 12px 14px; border-radius: 0 6px 6px 0;">
              <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #1e40af; letter-spacing: 0.5px; margin-bottom: 4px;">
                ⚡ One Clear Next Action
              </div>
              <div style="font-size: 13px; color: #1e3a8a; line-height: 1.5; font-weight: 500;">
                ${f.nextAction}
              </div>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitGuard Verdict Alert: ${decision} for ${repo}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a;">
  <div style="max-width: 680px; margin: 30px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
    
    <!-- Top Header Bar -->
    <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 24px 32px; color: #ffffff;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <span style="font-size: 20px; font-weight: 800; letter-spacing: -0.5px;">🛡️ GitGuard</span>
          <span style="font-size: 12px; margin-left: 8px; color: #94a3b8; font-weight: 500;">Automated Code Quality & Security</span>
        </div>
        <div style="background-color: rgba(255,255,255,0.1); padding: 4px 10px; border-radius: 6px; font-size: 12px; font-family: monospace;">
          sha: ${shortSha}
        </div>
      </div>
    </div>

    <!-- Verdict Banner -->
    <div style="background-color: ${statusBg}; border-bottom: 2px solid ${statusBorder}; padding: 20px 32px;">
      <div style="display: flex; align-items: center; gap: 12px;">
        <span style="font-size: 28px;">${statusEmoji}</span>
        <div>
          <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: ${statusColor};">
            Verdict: ${decision} — ${isBlock ? "Action Required Before Merging" : "Review Recommended"}
          </h1>
          <p style="margin: 4px 0 0 0; font-size: 14px; color: #475569;">
            Repository <strong>${repo}</strong> ${pullNumber ? `(Pull Request #${pullNumber})` : `(Commit ${shortSha})`}
          </p>
        </div>
      </div>
    </div>

    <!-- Review Metadata -->
    <div style="padding: 24px 32px; border-bottom: 1px solid #f1f5f9;">
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tr>
          <td style="padding: 6px 0; color: #64748b; width: 140px;"><strong>Repository:</strong></td>
          <td style="padding: 6px 0; font-weight: 600;"><a href="https://github.com/${repo}" style="color: #2563eb; text-decoration: none;">${repo}</a></td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;"><strong>Commit / PR:</strong></td>
          <td style="padding: 6px 0;">
            <a href="${prOrCommitUrl}" style="color: #2563eb; text-decoration: underline; font-weight: 600;" target="_blank">
              ${pullNumber ? `Pull Request #${pullNumber}` : `Commit ${shortSha}`} ↗
            </a>
          </td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;"><strong>Trigger Event:</strong></td>
          <td style="padding: 6px 0; text-transform: capitalize;">${event || "pull_request"}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;"><strong>Flagged Defects:</strong></td>
          <td style="padding: 6px 0; font-weight: 600; color: ${statusColor};">
            ${findings.length} actionable item${findings.length === 1 ? "" : "s"} identified
          </td>
        </tr>
      </table>
    </div>

    <!-- Findings Section -->
    <div style="padding: 24px 32px;">
      <h2 style="margin: 0 0 16px 0; font-size: 16px; font-weight: 700; color: #1e293b;">
        🔍 Specific Findings & Remediation Steps
      </h2>

      ${
        findings.length > 0
          ? findingsHtml
          : `<div style="padding: 16px; background-color: #f8fafc; border-radius: 8px; color: #64748b; font-size: 13px;">
               ${payload.summary || "No individual code locations were flagged, but review thresholds triggered this alert."}
             </div>`
      }

      <!-- Action Button -->
      <div style="margin-top: 28px; text-align: center;">
        <a href="${prOrCommitUrl}" style="display: inline-block; background-color: #0f172a; color: #ffffff; padding: 12px 28px; border-radius: 6px; font-size: 14px; font-weight: 600; text-decoration: none; box-shadow: 0 2px 4px rgba(0,0,0,0.1);" target="_blank">
          View Diff &amp; Triage on GitHub ↗
        </a>
      </div>
    </div>

    <!-- Footer -->
    <div style="background-color: #f8fafc; padding: 20px 32px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; line-height: 1.5;">
      <div>
        This automated security notification was sent to <strong>${recipient}</strong> for installation <code>${payload.installationId}</code>.
      </div>
      <div style="margin-top: 6px;">
        To manage notification thresholds or add team recipients, visit the 
        <a href="${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/dashboard/settings" style="color: #2563eb; text-decoration: underline;">GitGuard Alert Settings</a>.
      </div>
    </div>

  </div>
</body>
</html>
  `;
}

function buildAlertEmailText(
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
