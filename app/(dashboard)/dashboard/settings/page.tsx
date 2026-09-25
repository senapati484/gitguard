import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUid } from "@/lib/auth-session";
import { adminDb } from "@/lib/firebase-admin";
import { getAlertSettings } from "@/agents/email-agent";
import { AlertSettingsForm } from "@/components/dashboard/AlertSettingsForm";
import { getUserInstallationDocs } from "@/lib/installations";

export const metadata: Metadata = {
  title: "Alert Settings | GitGuard",
  description: "Configure email alerts and notification thresholds for your repositories.",
};

/**
 * app/(dashboard)/dashboard/settings/page.tsx  →  /dashboard/settings
 *
 * Configures notification preferences (email alerts via Nodemailer, Slack webhook,
 * and BLOCK / WARN criteria) persisted in Firestore.
 */
export default async function AlertSettingsPage() {
  const uid = await getSessionUid();
  if (!uid) redirect("/login");

  // Fetch this user's installations from Firestore
  const installationDocs = await getUserInstallationDocs(uid);

  const installations = installationDocs.map((doc) => ({
    id: doc.id,
    installationId: doc.data().installationId ?? doc.id,
  }));

  const primaryInstallId = installations[0]?.installationId || "5070835";
  const initialSettings = await getAlertSettings(primaryInstallId);

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Alert &amp; Notification Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure where and when GitGuard dispatches security alerts, file links, and actionable next steps.
        </p>
      </div>

      <AlertSettingsForm
        initialSettings={initialSettings}
        installations={installations}
      />
    </div>
  );
}
