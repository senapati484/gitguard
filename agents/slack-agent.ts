/**
 * agents/slack-agent.ts
 *
 * GitGuard Alert Dispatcher.
 *
 * Automatically dispatches alerts on BLOCK / WARN verdicts:
 *   1. Primary: Rich HTML Email alerts via Nodemailer (as specified by user requirement)
 *   2. Optional: Slack Block Kit incoming webhook message (if slackWebhookUrl is configured in Firestore)
 */

import {
  sendVerdictEmailAlert,
  getAlertSettings,
  saveAlertSettings,
  resolveActionableFindings,
  type VerdictAlertPayload,
  type AlertSettings,
  type ActionableFinding,
} from "@/agents/email-agent";

export {
  sendVerdictEmailAlert,
  getAlertSettings,
  saveAlertSettings,
  resolveActionableFindings,
  type VerdictAlertPayload,
  type AlertSettings,
  type ActionableFinding,
};

/**
 * Builds Slack Block Kit payload representing the flagged findings and actionable next steps.
 */
export function buildSlackBlockKitPayload(
  payload: VerdictAlertPayload,
  findings: ActionableFinding[]
) {
  const { repo, sha, decision, pullNumber, autoSolved, autoSolvedCommitSha } = payload;
  const isBlock = decision === "BLOCK" && !autoSolved;
  const emoji = autoSolved ? "⚡" : isBlock ? "🚨" : "⚠️";
  const shortSha = sha.slice(0, 7);
  const prOrCommitUrl = pullNumber
    ? `https://github.com/${repo}/pull/${pullNumber}`
    : autoSolvedCommitSha
    ? `https://github.com/${repo}/commit/${autoSolvedCommitSha}`
    : `https://github.com/${repo}/commit/${sha}`;

  const verdictLabel = autoSolved && autoSolvedCommitSha
    ? `\`PASS (Auto-Solved & Pushed)\``
    : `\`${decision}\` (${isBlock ? "Merge Blocked" : "Review Suggested"})`;

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${emoji} GitGuard ${autoSolved ? "Auto-Solved & Pushed" : decision}: ${repo}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Repository:*\n<https://github.com/${repo}|${repo}>`,
        },
        {
          type: "mrkdwn",
          text: `*Verdict:*\n${verdictLabel}`,
        },
        {
          type: "mrkdwn",
          text: `*Commit / PR:*\n<${prOrCommitUrl}|${autoSolvedCommitSha ? `clean: ${autoSolvedCommitSha.slice(0, 7)}` : pullNumber ? `PR #${pullNumber}` : shortSha}>`,
        },
        {
          type: "mrkdwn",
          text: `*Resolved Items:*\n${findings.length} defect(s)`,
        },
      ],
    },
    {
      type: "divider",
    },
  ];

  // Add individual finding blocks (up to 8 to avoid Slack block limit)
  findings.slice(0, 8).forEach((f, idx) => {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*#${idx + 1} [${f.severity.toUpperCase()}] ${f.title}*\n• *Location:* <${f.fileUrl}|\`${f.file}:${f.line}\`>\n• *Details:* ${f.description}\n• *⚡ One Clear Next Action:* _${f.nextAction}_`,
      },
    });
  });

  // Action button
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "View Pull Request on GitHub",
          emoji: true,
        },
        url: prOrCommitUrl,
        style: isBlock ? "danger" : "primary",
      },
    ],
  });

  return {
    text: `${emoji} [${decision}] GitGuard flagged ${findings.length} issue(s) in ${repo} (${shortSha})`,
    blocks,
  };
}

/**
 * Sends alert to Slack webhook if configured, and dispatches primary email alert.
 */
export async function sendVerdictAlert(payload: VerdictAlertPayload) {
  // 1. Primary: Send email alert via Nodemailer
  const emailResult = await sendVerdictEmailAlert(payload);

  // 2. Optional: If Slack webhook URL is configured in settings, post Block Kit message
  const settings = await getAlertSettings(payload.installationId);
  let slackSent = false;

  if (settings.slackWebhookUrl && settings.slackWebhookUrl.startsWith("https://")) {
    try {
      const findings = resolveActionableFindings(payload);
      const slackBody = buildSlackBlockKitPayload(payload, findings);

      const resp = await fetch(settings.slackWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(slackBody),
      });

      slackSent = resp.ok;
      console.log(`[slack-agent] Slack alert sent (status: ${resp.status})`);
    } catch (err) {
      console.warn(`[slack-agent] Failed to post to Slack webhook:`, err);
    }
  }

  return {
    emailResult,
    slackSent,
  };
}

export default sendVerdictAlert;
