/**
 * lib/plan-config.ts
 *
 * Client-safe tier definitions, pricing metadata, and plan mapping utilities.
 * This file has ZERO dependencies on Node.js built-ins or firebase-admin,
 * making it 100% safe to import in client components ("use client") and server components alike.
 */

export type PlanTier = "free" | "pro" | "team";
export type BillingProvider = "marketplace" | "stripe" | "free" | "none";

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
  billingProvider?: BillingProvider;
}

export interface InstallationPlanInfo {
  id: string;
  installationId: number | string;
  accountLogin?: string;
  plan: PlanTier;
  monthlyChecksCount: number;
  monthlyChecksLimit: number;
  unlimited: boolean;
  resetMonth: string;
  billingProvider?: BillingProvider;
  marketplaceStatus?: string;
  stripeStatus?: string;
}

/**
 * Maps a GitHub Marketplace plan name to the standardized PlanTier.
 * E.g. "GitGuard Pro", "Pro Plan", "Pro" -> "pro"
 *      "GitGuard Team", "Team Plan", "Enterprise" -> "team"
 *      "Free", "Open Source" -> "free"
 */
export function mapMarketplacePlanToTier(planName: string): PlanTier {
  if (!planName) return "free";
  const normalized = planName.toLowerCase().trim();
  if (
    normalized.includes("team") ||
    normalized.includes("enterprise") ||
    normalized.includes("organization") ||
    normalized.includes("fleet")
  ) {
    return "team";
  }
  if (
    normalized.includes("pro") ||
    normalized.includes("business") ||
    normalized.includes("developer") ||
    normalized.includes("premium")
  ) {
    return "pro";
  }
  return "free";
}

export interface BillingRecordState {
  plan?: PlanTier;
  status?: string;
  billingCycle?: "monthly" | "yearly";
  updatedAt?: number;
}

export interface InstallationBillingDoc {
  plan?: PlanTier;
  billingProvider?: BillingProvider;
  marketplace?: BillingRecordState & {
    planId?: number;
    planName?: string;
    accountId?: number;
    accountLogin?: string;
  };
  stripe?: BillingRecordState & {
    customerId?: string;
    subscriptionId?: string;
  };
}

/**
 * Resolves the effective plan for an installation.
 * CRITICAL RULE: Prefer Marketplace billing over Stripe when both exist and are active.
 */
export function resolveEffectivePlan(data: InstallationBillingDoc): {
  effectivePlan: PlanTier;
  provider: BillingProvider;
} {
  // 1. Check Marketplace billing first (Marketplace takes precedence over Stripe)
  const mp = data.marketplace;
  if (mp && mp.status === "active" && mp.plan && mp.plan !== "free") {
    return {
      effectivePlan: mp.plan,
      provider: "marketplace",
    };
  }

  // 2. Check Stripe billing second
  const st = data.stripe;
  if (st && st.status === "active" && st.plan && st.plan !== "free") {
    return {
      effectivePlan: st.plan,
      provider: "stripe",
    };
  }

  // 3. If either has explicitly active free plan
  if (
    (mp && mp.status === "active" && mp.plan === "free") ||
    (st && st.status === "active" && st.plan === "free")
  ) {
    return {
      effectivePlan: "free",
      provider: mp?.status === "active" ? "marketplace" : "stripe",
    };
  }

  // 4. If either marketplace or stripe is present and cancelled/inactive,
  // and neither has an active subscription, the tier reverts to "free"
  if (
    (mp && (mp.status === "cancelled" || mp.status === "pending_change")) ||
    (st && (st.status === "cancelled" || st.status === "past_due"))
  ) {
    return {
      effectivePlan: "free",
      provider: "free",
    };
  }

  // 5. Fallback for manual/demo plan when neither provider is active/cancelled
  const manualPlan = data.plan;
  if (manualPlan === "pro" || manualPlan === "team") {
    return {
      effectivePlan: manualPlan,
      provider: (data.billingProvider as BillingProvider) || "free",
    };
  }

  return {
    effectivePlan: "free",
    provider: "free",
  };
}
