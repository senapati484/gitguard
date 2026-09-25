"use client";

import { useState } from "react";
import type { AlertSettings } from "@/agents/email-agent";

interface AlertSettingsFormProps {
  initialSettings: AlertSettings;
  installations: Array<{ id: string; installationId: number | string }>;
}

export function AlertSettingsForm({
  initialSettings,
  installations,
}: AlertSettingsFormProps) {
  const [selectedInstallId, setSelectedInstallId] = useState<string>(
    String(initialSettings.installationId || (installations[0]?.installationId ?? "5070835"))
  );
  const [alertEmail, setAlertEmail] = useState<string>(
    initialSettings.alertEmail || "developersayan01@gmail.com"
  );
  const [notifyOnBlock, setNotifyOnBlock] = useState<boolean>(
    initialSettings.notifyOnBlock ?? true
  );
  const [notifyOnWarn, setNotifyOnWarn] = useState<boolean>(
    initialSettings.notifyOnWarn ?? true
  );
  const [notifyOnPass, setNotifyOnPass] = useState<boolean>(
    initialSettings.notifyOnPass ?? false
  );
  const [slackWebhookUrl, setSlackWebhookUrl] = useState<string>(
    initialSettings.slackWebhookUrl || ""
  );

  const [saving, setSaving] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMessage(null);

    try {
      const res = await fetch(`/api/settings/${selectedInstallId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          alertEmail,
          notifyOnBlock,
          notifyOnWarn,
          notifyOnPass,
          slackWebhookUrl,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to save settings");
      }

      setStatusMessage({
        type: "success",
        text: "Alert settings saved successfully to Firestore!",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage({ type: "error", text: msg });
    } finally {
      setSaving(false);
    }
  };

  const handleSendTest = async () => {
    if (!alertEmail.trim() || !alertEmail.includes("@")) {
      setStatusMessage({
        type: "error",
        text: "Please provide a valid recipient email address first.",
      });
      return;
    }

    setTesting(true);
    setStatusMessage(null);

    try {
      const res = await fetch(`/api/settings/${selectedInstallId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          testEmail: alertEmail.split(",")[0].trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details || data.error || "Failed to send test email");
      }

      setStatusMessage({
        type: "success",
        text: `Test email sent to ${alertEmail.split(",")[0].trim()}! Check your inbox.`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage({ type: "error", text: msg });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      {statusMessage && (
        <div
          className={`rounded-lg p-4 text-sm font-medium border ${
            statusMessage.type === "success"
              ? "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800"
              : "bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800"
          }`}
        >
          {statusMessage.type === "success" ? "✅ " : "❌ "}
          {statusMessage.text}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        {/* Installation Selection */}
        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight">GitHub Installation</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Select the GitHub App installation associated with your repositories.
          </p>

          <div className="mt-4 max-w-md">
            {installations.length > 0 ? (
              <select
                value={selectedInstallId}
                onChange={(e) => setSelectedInstallId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {installations.map((inst) => (
                  <option key={inst.id} value={String(inst.installationId)}>
                    Installation ID: {inst.installationId}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={selectedInstallId}
                onChange={(e) => setSelectedInstallId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="e.g. 5070835"
              />
            )}
          </div>
        </div>

        {/* Email Alert Settings */}
        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Email Alert Notification</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Triggered automatically on BLOCK and WARN verdicts via Nodemailer.
              </p>
            </div>
            <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
              Nodemailer Active
            </span>
          </div>

          <div className="mt-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground">
                Alert Recipient Email(s)
              </label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Comma-separated email addresses to notify when code security or correctness violations occur.
              </p>
              <input
                type="text"
                value={alertEmail}
                onChange={(e) => setAlertEmail(e.target.value)}
                placeholder="developersayan01@gmail.com, security@company.com"
                className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {/* Notification Criteria Checkboxes */}
            <div className="pt-2 border-t border-border space-y-3">
              <label className="text-sm font-medium text-foreground block">
                Notification Thresholds
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={notifyOnBlock}
                  onChange={(e) => setNotifyOnBlock(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <div>
                  <span className="text-sm font-medium text-foreground">
                    Notify on 🚨 BLOCK verdicts (Recommended)
                  </span>
                  <p className="text-xs text-muted-foreground">
                    Sent when confirmed secrets, critical bugs, or exploitable security vulnerabilities are detected.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={notifyOnWarn}
                  onChange={(e) => setNotifyOnWarn(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <div>
                  <span className="text-sm font-medium text-foreground">
                    Notify on ⚠️ WARN verdicts
                  </span>
                  <p className="text-xs text-muted-foreground">
                    Sent when medium/low severity bugs or non-exploitable security notices are identified.
                  </p>
                </div>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={notifyOnPass}
                  onChange={(e) => setNotifyOnPass(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <div>
                  <span className="text-sm font-medium text-foreground">
                    Notify on ✅ PASS verdicts
                  </span>
                  <p className="text-xs text-muted-foreground">
                    Sent for pristine PRs with zero defects detected across all agents.
                  </p>
                </div>
              </label>
            </div>
          </div>
        </div>

        {/* Optional Slack Webhook */}
        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold tracking-tight">Slack Integration (Optional)</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Optionally dispatch Block Kit cards to a Slack incoming webhook.
          </p>

          <div className="mt-4">
            <label className="block text-sm font-medium text-foreground">
              Slack Incoming Webhook URL
            </label>
            <input
              type="url"
              value={slackWebhookUrl}
              onChange={(e) => setSlackWebhookUrl(e.target.value)}
              placeholder="https://example.com/webhook-endpoint"
              className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          >
            {saving ? "Saving to Firestore..." : "Save Alert Settings"}
          </button>

          <button
            type="button"
            onClick={handleSendTest}
            disabled={testing}
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-semibold text-foreground shadow-sm hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          >
            {testing ? "Dispatching Test Email..." : "Send Test Alert Email ↗"}
          </button>
        </div>
      </form>
    </div>
  );
}
