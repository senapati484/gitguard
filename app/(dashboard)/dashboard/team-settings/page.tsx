import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUid } from "@/lib/auth-session";
import { adminDb } from "@/lib/firebase-admin";
import { checkInstallationQuota } from "@/lib/plan-limits";
import type { InstallationPlanInfo } from "@/lib/plan-config";
import { TeamPolicyForm } from "@/components/dashboard/TeamPolicyForm";
import { getUserInstallationDocs } from "@/lib/installations";

export const metadata: Metadata = {
  title: "Team Policy & Audit Logs | GitGuard",
  description:
    "Org-wide policy enforcement, custom Gitleaks secret regex patterns, verdict overrides, and immutable compliance audit logs.",
};

/**
 * app/(dashboard)/dashboard/team-settings/page.tsx  →  /dashboard/team-settings
 *
 * Team-plan Org-Wide Policy settings:
 *  - Required agents
 *  - Severity thresholds
 *  - Custom regex secret patterns merged into gitleaks config
 *  - Immutable audit-log collection recording every ignore, override, and policy change
 */
export default async function TeamSettingsPage() {
  const uid = await getSessionUid();
  if (!uid) redirect("/login");

  // Fetch user's installations from Firestore
  const installationDocs = await getUserInstallationDocs(uid);

  const rawInstallations = installationDocs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as {
      installationId: number | string;
      accountLogin?: string;
    }),
  }));

  // Fetch plan & quota info for each installation
  const installations: InstallationPlanInfo[] = await Promise.all(
    rawInstallations.map(async (inst) => {
      const quota = await checkInstallationQuota(inst.installationId);
      return {
        id: inst.id,
        installationId: inst.installationId,
        accountLogin: inst.accountLogin || `Installation #${inst.installationId}`,
        plan: quota.plan,
        monthlyChecksCount: quota.currentCount,
        monthlyChecksLimit: quota.monthlyLimit === Infinity ? 999999 : quota.monthlyLimit,
        unlimited: quota.unlimited,
        resetMonth: quota.resetMonth,
        billingProvider: quota.billingProvider,
      };
    })
  );

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Breadcrumb Navigation */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/dashboard" className="hover:text-foreground transition">
          Dashboard
        </Link>
        <span>/</span>
        <span className="text-foreground font-medium">Team Policy &amp; Audit Logs</span>
      </div>

      <TeamPolicyForm
        installations={installations}
        defaultInstallationId={installations[0]?.installationId}
      />
    </div>
  );
}
