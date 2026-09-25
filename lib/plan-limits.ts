/**
 * lib/plan-limits.ts
 *
 * Tier definitions, agent gating rules, and monthly quota counters for GitGuard.
 *
 * Tiers:
 *   - Free: 50 checks/month.
 *           Runs SecretAgent + CommitAgent + basic BugAgent + HealthAgent score only.
 *   - Pro:  Unlimited checks/month.
 *           Runs all 7 agents (including Semgrep SecurityAgent, SEOAgent, DialogueNode).
 *   - Team: Unlimited checks/month.
 *           Runs all 7 agents + priority queuing and fleet analytics.
 */

import { adminDb } from "@/lib/firebase-admin";

export type PlanTier = "free" | "pro" | "team";

export interface PlanConfig {
  tier: PlanTier;
  name: string;
  tagline: string;
  priceMonthly: number;
  priceYearly: number;
  monthlyChecksQuota: number;
  unlimitedChecks: boolean;
  agents: {
    secretAgent: boolean;
    commitAgent: boolean;
    bugAgent: "basic" | "full";
    healthAgent: boolean;
    securityAgent: boolean;
    seoAgent: boolean;
    dialogueArbitration: boolean;
    emailAlerts: boolean;
  };
  features: string[];
}

export const PLAN_CONFIGS: Record<PlanTier, PlanConfig> = {
  free: {
    tier: "free",
    name: "Free",
    tagline: "Essential hygiene for personal repositories and open source projects.",
    priceMonthly: 0,
    priceYearly: 0,
    monthlyChecksQuota: 50,
    unlimitedChecks: false,
    agents: {
      secretAgent: true,
      commitAgent: true,
      bugAgent: "basic",
      healthAgent: true,
      securityAgent: false,
      seoAgent: false,
      dialogueArbitration: false,
      emailAlerts: false,
    },
    features: [
      "50 checks / month per installation",
      "SecretAgent: Gitleaks SAST & AI false-positive filter",
      "CommitAgent: Conventional Commit generator",
      "BugAgent: Core null derefs & unhandled promises",
      "HealthAgent: Basic 0-100 composite health score",
      "Public README SVG badge embed",
    ],
  },
  pro: {
    tier: "pro",
    name: "Pro",
    tagline: "Autonomous security gatekeeping and multi-agent consensus for fast teams.",
    priceMonthly: 29,
    priceYearly: 24,
    monthlyChecksQuota: Infinity,
    unlimitedChecks: true,
    agents: {
      secretAgent: true,
      commitAgent: true,
      bugAgent: "full",
      healthAgent: true,
      securityAgent: true,
      seoAgent: true,
      dialogueArbitration: true,
      emailAlerts: true,
    },
    features: [
      "Unlimited PR & push review runs",
      "All 7 Agents active in parallel LangGraph topology",
      "BugAgent: High-confidence 1-click GitHub suggested changes",
      "SecurityAgent: Semgrep OWASP Top 10 + Exploitability Reasoning",
      "SEOAgent: Meta tags, Open Graph & CLS layout shift audit",
      "DialogueNode: Consensus arbitration on colliding findings",
      "Instant Email / Slack notifications on BLOCK & WARN verdicts",
      ".gitguardignore audited bypass tracking",
    ],
  },
  team: {
    tier: "team",
    name: "Team",
    tagline: "Fleet-wide governance, custom security policies, and high-concurrency pipelines.",
    priceMonthly: 79,
    priceYearly: 69,
    monthlyChecksQuota: Infinity,
    unlimitedChecks: true,
    agents: {
      secretAgent: true,
      commitAgent: true,
      bugAgent: "full",
      healthAgent: true,
      securityAgent: true,
      seoAgent: true,
      dialogueArbitration: true,
      emailAlerts: true,
    },
    features: [
      "Everything in Pro, plus:",
      "Multi-repository organizational health scorecards",
      "Priority BullMQ queue execution",
      "Custom .gitguardignore policy enforcement",
      "Dedicated Sonnet arbitration model quota",
      "Centralized billing & member management",
    ],
  },
};

/**
 * Returns current month string "YYYY-MM" in UTC.
 */
export function getCurrentMonthKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export interface QuotaCheckResult {
  allowed: boolean;
  plan: PlanTier;
  currentCount: number;
  monthlyLimit: number;
  unlimited: boolean;
  resetMonth: string;
  reason?: string;
  installationDocId?: string;
}

/**
 * Checks the installation's current plan and monthly quota in Cloud Firestore.
 * Automatically resets the monthly counter if entering a new billing calendar month.
 */
export async function checkInstallationQuota(
  installationId: string | number
): Promise<QuotaCheckResult> {
  const installIdStr = String(installationId);
  const installIdNum = Number(installationId);
  const currentMonth = getCurrentMonthKey();

  try {
    const installRef = adminDb.collection("installations");

    // 1. Locate installation document
    let docSnap = await installRef.doc(installIdStr).get();
    let docId = installIdStr;

    if (!docSnap.exists) {
      const q = await installRef
        .where("installationId", "in", [installIdStr, !isNaN(installIdNum) ? installIdNum : installIdStr])
        .limit(1)
        .get();

      if (!q.empty) {
        docSnap = q.docs[0];
        docId = docSnap.id;
      }
    }

    if (!docSnap.exists) {
      // Default fallback if installation document has not synchronized yet
      return {
        allowed: true,
        plan: "free",
        currentCount: 0,
        monthlyLimit: 50,
        unlimited: false,
        resetMonth: currentMonth,
      };
    }

    const data = docSnap.data() || {};
    const rawPlan = String(data.plan || "free").toLowerCase();
    const plan: PlanTier = rawPlan === "pro" || rawPlan === "team" ? rawPlan : "free";

    const lastResetMonth = data.lastCounterResetMonth || "";
    let currentCount = typeof data.monthlyChecksCount === "number" ? data.monthlyChecksCount : 0;

    // Reset counter if calendar month has changed
    if (lastResetMonth !== currentMonth) {
      currentCount = 0;
      await installRef.doc(docId).set(
        {
          monthlyChecksCount: 0,
          lastCounterResetMonth: currentMonth,
        },
        { merge: true }
      );
    }

    const config = PLAN_CONFIGS[plan];

    if (config.unlimitedChecks) {
      return {
        allowed: true,
        plan,
        currentCount,
        monthlyLimit: Infinity,
        unlimited: true,
        resetMonth: currentMonth,
        installationDocId: docId,
      };
    }

    // Free plan cap: 50 checks / month
    if (currentCount >= config.monthlyChecksQuota) {
      return {
        allowed: false,
        plan,
        currentCount,
        monthlyLimit: config.monthlyChecksQuota,
        unlimited: false,
        resetMonth: currentMonth,
        installationDocId: docId,
        reason: `Monthly quota exceeded (${currentCount}/${config.monthlyChecksQuota} checks used in ${currentMonth}). Upgrade to Pro or Team for unlimited checks and full multi-agent scanning.`,
      };
    }

    return {
      allowed: true,
      plan,
      currentCount,
      monthlyLimit: config.monthlyChecksQuota,
      unlimited: false,
      resetMonth: currentMonth,
      installationDocId: docId,
    };
  } catch (err) {
    console.error(`[plan-limits] Error checking quota for installation ${installationId}:`, err);
    // Fail-open for developer safety
    return {
      allowed: true,
      plan: "free",
      currentCount: 0,
      monthlyLimit: 50,
      unlimited: false,
      resetMonth: currentMonth,
    };
  }
}

/**
 * Increments the monthly checks counter on the installation document.
 */
export async function incrementInstallationCheckCount(
  installationId: string | number,
  installationDocId?: string
): Promise<number> {
  const installIdStr = String(installationId);
  const currentMonth = getCurrentMonthKey();

  try {
    const installRef = adminDb.collection("installations");
    const targetId = installationDocId || installIdStr;

    const doc = await installRef.doc(targetId).get();
    if (doc.exists) {
      const current = typeof doc.data()?.monthlyChecksCount === "number" ? doc.data()!.monthlyChecksCount : 0;
      const next = current + 1;
      await installRef.doc(targetId).set(
        {
          monthlyChecksCount: next,
          lastCounterResetMonth: currentMonth,
          lastCheckAt: Date.now(),
        },
        { merge: true }
      );
      return next;
    }
  } catch (err) {
    console.warn(`[plan-limits] Could not increment check count for installation ${installationId}:`, err);
  }
  return 1;
}

/**
 * Updates the plan on the installation document in Cloud Firestore (Demo / Admin function).
 */
export async function setInstallationPlan(
  installationId: string | number,
  newPlan: PlanTier,
  options: { resetCounter?: boolean; billingCycle?: "monthly" | "yearly" } = {}
): Promise<void> {
  const installIdStr = String(installationId);
  const installIdNum = Number(installationId);
  const currentMonth = getCurrentMonthKey();

  const installRef = adminDb.collection("installations");

  let targetId = installIdStr;
  const docSnap = await installRef.doc(installIdStr).get();

  if (!docSnap.exists) {
    const q = await installRef
      .where("installationId", "in", [installIdStr, !isNaN(installIdNum) ? installIdNum : installIdStr])
      .limit(1)
      .get();
    if (!q.empty) {
      targetId = q.docs[0].id;
    }
  }

  const updateData: Record<string, unknown> = {
    plan: newPlan,
    planUpdatedAt: Date.now(),
    billingCycle: options.billingCycle || "monthly",
  };

  if (options.resetCounter) {
    updateData.monthlyChecksCount = 0;
    updateData.lastCounterResetMonth = currentMonth;
  }

  await installRef.doc(targetId).set(updateData, { merge: true });
  console.log(`[plan-limits] Updated installation ${installationId} to plan "${newPlan}"`);
}
