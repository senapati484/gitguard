/**
 * lib/plan-limits.ts
 *
 * Tier definitions, agent gating rules, and monthly quota counters for GitGuard.
 * Supports GitHub Marketplace and Stripe billing reconciliation with Marketplace priority.
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
import {
  PLAN_CONFIGS,
  type PlanTier,
  type BillingProvider,
  getCurrentMonthKey,
  mapMarketplacePlanToTier,
  resolveEffectivePlan,
  type InstallationBillingDoc,
  type QuotaCheckResult,
} from "./plan-config";

// Re-export client-safe configs and types
export * from "./plan-config";

/**
 * Checks the installation's current plan and monthly quota in Cloud Firestore.
 * Automatically resets the monthly counter if entering a new billing calendar month.
 * Prefers GitHub Marketplace billing over Stripe when both exist.
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
        billingProvider: "free",
      };
    }

    const data = (docSnap.data() || {}) as InstallationBillingDoc & Record<string, unknown>;

    // Resolve plan adhering to billing priority (Marketplace > Stripe > manual/free)
    const { effectivePlan, provider } = resolveEffectivePlan(data);
    const plan: PlanTier = effectivePlan;

    // Ensure the root `plan` and `billingProvider` fields stay synchronized
    if (data.plan !== effectivePlan || data.billingProvider !== provider) {
      await installRef.doc(docId).set(
        {
          plan: effectivePlan,
          billingProvider: provider,
        },
        { merge: true }
      );
    }

    const lastResetMonth = String(data.lastCounterResetMonth || "");
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
        billingProvider: provider,
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
        billingProvider: provider,
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
      billingProvider: provider,
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
      billingProvider: "free",
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
  options: { resetCounter?: boolean; billingCycle?: "monthly" | "yearly"; provider?: BillingProvider } = {}
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
    billingProvider: options.provider || "free",
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

// ---------------------------------------------------------------------------
// GitHub Marketplace Webhook Interfaces & Handler
// ---------------------------------------------------------------------------

export interface GitHubMarketplaceWebhookPayload {
  action: "purchased" | "changed" | "cancelled" | "pending_change" | "pending_change_cancelled";
  effective_date?: string;
  sender?: { login: string; id: number };
  marketplace_purchase: {
    account: {
      type: "User" | "Organization";
      id: number;
      login: string;
      organization_billing_email?: string;
    };
    billing_cycle?: "monthly" | "yearly";
    unit_count?: number;
    on_free_trial?: boolean;
    free_trial_ends_on?: string | null;
    next_billing_date?: string | null;
    plan: {
      id: number;
      name: string;
      description?: string;
      monthly_price_in_cents?: number;
      yearly_price_in_cents?: number;
      price_model?: string;
    };
  };
  previous_marketplace_purchase?: {
    plan?: { id: number; name: string };
  };
}

/**
 * Handles GitHub Marketplace webhook events:
 *  - "purchased": maps plan and sets status="active"
 *  - "changed": updates tier to new plan, sets status="active"
 *  - "cancelled": sets status="cancelled", reverts plan or falls back to Stripe if active
 *  - "pending_change": records scheduled future change
 *
 * CRITICAL RULE: Prefer Marketplace billing over Stripe when both exist for an installation.
 */
export async function handleMarketplacePurchaseEvent(
  payload: GitHubMarketplaceWebhookPayload
): Promise<{
  success: boolean;
  action: string;
  mappedPlan: PlanTier;
  updatedCount: number;
  effectivePlan: PlanTier;
  provider: BillingProvider;
}> {
  const { action, marketplace_purchase: mp, effective_date } = payload;
  const account = mp?.account;
  const planObj = mp?.plan;

  if (!account || !planObj) {
    console.warn("[marketplace] Missing account or plan in webhook payload");
    return {
      success: false,
      action,
      mappedPlan: "free",
      updatedCount: 0,
      effectivePlan: "free",
      provider: "free",
    };
  }

  const rawPlanName = planObj.name || "";
  const mappedPlan = mapMarketplacePlanToTier(rawPlanName);
  const accountLogin = account.login;
  const accountId = account.id;

  let marketplaceStatus = "active";
  if (action === "cancelled") {
    marketplaceStatus = "cancelled";
  } else if (action === "pending_change") {
    marketplaceStatus = "pending_change";
  }

  console.log(
    `[marketplace] Processing event action="${action}" account="${accountLogin}" (ID: ${accountId}) plan="${rawPlanName}" -> mappedTier="${mappedPlan}" status="${marketplaceStatus}"`
  );

  const installRef = adminDb.collection("installations");

  // Find installations matching accountLogin or accountId
  const matchedDocs: FirebaseFirestore.DocumentSnapshot[] = [];

  // Query by accountLogin
  const snapByLogin = await installRef.where("accountLogin", "==", accountLogin).get();
  snapByLogin.docs.forEach((d) => matchedDocs.push(d));

  // Query by accountId
  if (accountId) {
    const snapById = await installRef.where("accountId", "==", accountId).get();
    snapById.docs.forEach((d) => {
      if (!matchedDocs.some((existing) => existing.id === d.id)) {
        matchedDocs.push(d);
      }
    });
  }

  // Also query if doc id is the accountId
  if (matchedDocs.length === 0 && accountId) {
    const directDoc = await installRef.doc(String(accountId)).get();
    if (directDoc.exists) {
      matchedDocs.push(directDoc);
    }
  }

  const marketplaceData = {
    plan: action === "cancelled" ? "free" : mappedPlan,
    status: marketplaceStatus,
    planId: planObj.id,
    planName: rawPlanName,
    billingCycle: mp.billing_cycle || "monthly",
    accountId,
    accountLogin,
    updatedAt: Date.now(),
    effectiveDate: effective_date || new Date().toISOString(),
    nextBillingDate: mp.next_billing_date || null,
    onFreeTrial: Boolean(mp.on_free_trial),
  };

  let effectivePlan: PlanTier = mappedPlan;
  let effectiveProvider: BillingProvider = "marketplace";

  if (matchedDocs.length > 0) {
    for (const doc of matchedDocs) {
      const existingData = (doc.data() || {}) as InstallationBillingDoc;

      // Merge candidate data
      const mergedDoc: InstallationBillingDoc = {
        ...existingData,
        marketplace: {
          ...existingData.marketplace,
          ...marketplaceData,
        },
      };

      // Resolve effective plan with Marketplace > Stripe precedence
      const resolved = resolveEffectivePlan(mergedDoc);
      effectivePlan = resolved.effectivePlan;
      effectiveProvider = resolved.provider;

      await installRef.doc(doc.id).set(
        {
          accountLogin,
          accountId,
          plan: effectivePlan, // Maps to the same `plan` field Stripe uses!
          billingProvider: effectiveProvider,
          marketplace: marketplaceData,
          updatedAt: Date.now(),
        },
        { merge: true }
      );

      console.log(
        `[marketplace] Updated installation doc="${doc.id}" with plan="${effectivePlan}" provider="${effectiveProvider}"`
      );
    }
  } else {
    // If installation document is not yet created (e.g. user bought on Marketplace before installing app),
    // store pre-provisioned marketplace purchase record keyed by account login so /api/setup adopts it.
    const preDocRef = installRef.doc(`marketplace_${accountLogin.toLowerCase()}`);
    const resolved = resolveEffectivePlan({
      marketplace: marketplaceData,
    });
    effectivePlan = resolved.effectivePlan;
    effectiveProvider = resolved.provider;

    await preDocRef.set(
      {
        accountLogin,
        accountId,
        plan: effectivePlan,
        billingProvider: effectiveProvider,
        marketplace: marketplaceData,
        isPreProvisioned: true,
        updatedAt: Date.now(),
      },
      { merge: true }
    );

    console.log(
      `[marketplace] Pre-provisioned marketplace purchase for "${accountLogin}" at doc="marketplace_${accountLogin.toLowerCase()}"`
    );
  }

  // Also log to dedicated audit collection
  try {
    await adminDb.collection("marketplace_events").add({
      action,
      accountLogin,
      accountId,
      rawPlanName,
      mappedPlan,
      effectivePlan,
      billingProvider: effectiveProvider,
      payload,
      createdAt: Date.now(),
    });
  } catch (err) {
    console.warn("[marketplace] Failed to log marketplace event to audit collection:", err);
  }

  return {
    success: true,
    action,
    mappedPlan,
    updatedCount: Math.max(1, matchedDocs.length),
    effectivePlan,
    provider: effectiveProvider,
  };
}

/**
 * Handles Stripe subscription webhook events.
 * Adheres to precedence rule: If Marketplace billing is currently active, Marketplace PREVAILS.
 */
export async function handleStripeSubscriptionEvent(
  installationId: string | number,
  stripeData: {
    plan: PlanTier;
    status: "active" | "cancelled" | "past_due";
    customerId?: string;
    subscriptionId?: string;
    billingCycle?: "monthly" | "yearly";
  }
): Promise<{ effectivePlan: PlanTier; provider: BillingProvider }> {
  const installIdStr = String(installationId);
  const installRef = adminDb.collection("installations").doc(installIdStr);

  const snap = await installRef.get();
  const existingData = (snap.data() || {}) as InstallationBillingDoc;

  const mergedDoc: InstallationBillingDoc = {
    ...existingData,
    stripe: {
      ...existingData.stripe,
      ...stripeData,
      updatedAt: Date.now(),
    },
  };

  // Preference check: If Marketplace billing exists and is active, Marketplace PREVAILS
  const { effectivePlan, provider } = resolveEffectivePlan(mergedDoc);

  await installRef.set(
    {
      plan: effectivePlan,
      billingProvider: provider,
      stripe: {
        ...stripeData,
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    },
    { merge: true }
  );

  console.log(
    `[stripe] Updated installation ${installationId} stripe plan="${stripeData.plan}" (effectivePlan="${effectivePlan}" provider="${provider}")`
  );

  return { effectivePlan, provider };
}
