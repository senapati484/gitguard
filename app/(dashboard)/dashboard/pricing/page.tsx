import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUid } from "@/lib/auth-session";
import { checkInstallationQuota } from "@/lib/plan-limits";
import {
  PricingPlansView,
  type InstallationPlanInfo,
} from "@/components/dashboard/PricingPlansView";
import { getUserInstallationDocs } from "@/lib/installations";

export const metadata: Metadata = {
  title: "Plans & Pricing | GitGuard",
  description: "Explore GitGuard tiers, upcoming Stripe checkout, and agent execution gating.",
};

/**
 * app/(dashboard)/dashboard/pricing/page.tsx
 *
 * Displays pricing tiers (Free vs Pro vs Team), upcoming Stripe integration notice,
 * and a 1-click sandbox plan switcher for authorized installations.
 */
export default async function PricingPage() {
  const uid = await getSessionUid();
  if (!uid) redirect("/login");

  // 1. Fetch user's installations
  const installationDocs = await getUserInstallationDocs(uid);

  const rawInstallations = installationDocs.map((doc) => {
    const data = doc.data() as {
      installationId: number | string;
      accountLogin?: string;
      primaryRepo?: string;
      repo?: string;
    };
    return {
      id: doc.id,
      ...data,
    };
  });

  // 2. Map installation quotas & plan info
  const installations: InstallationPlanInfo[] = await Promise.all(
    rawInstallations.map(async (inst) => {
      const quota = await checkInstallationQuota(inst.installationId);
      const primaryRepo = inst.primaryRepo || inst.repo || (inst.accountLogin ? `${inst.accountLogin}/gitguard` : undefined);
      return {
        id: inst.id,
        installationId: inst.installationId,
        accountLogin: inst.accountLogin || `Installation #${inst.installationId}`,
        primaryRepo,
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
    <div className="space-y-6">
      {/* Breadcrumb Navigation */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/dashboard" className="hover:text-foreground transition">
          Dashboard
        </Link>
        <span>/</span>
        <span className="text-foreground font-medium">Plans &amp; Pricing</span>
      </div>

      {/* Pricing View Component with local demo switcher */}
      <PricingPlansView installations={installations} />
    </div>
  );
}
