/**
 * app/api/installations/[id]/plan/route.ts
 *
 * GET: Returns current plan tier, monthly checks quota, and usage.
 * POST: Switches plan tier ("free" | "pro" | "team") and supports resetting counter in demo mode.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUid } from "@/lib/auth-session";
import { adminDb } from "@/lib/firebase-admin";
import {
  setInstallationPlan,
  checkInstallationQuota,
  PLAN_CONFIGS,
  type PlanTier,
} from "@/lib/plan-limits";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const uid = await getSessionUid();
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const quota = await checkInstallationQuota(id);
  const config = PLAN_CONFIGS[quota.plan];

  return NextResponse.json({
    installationId: id,
    plan: quota.plan,
    planName: config.name,
    currentCount: quota.currentCount,
    monthlyLimit: quota.monthlyLimit,
    unlimited: quota.unlimited,
    resetMonth: quota.resetMonth,
    config,
  });
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const uid = await getSessionUid();
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const installIdStr = String(id);
  const installIdNum = Number(id);

  // Authorize user against adminUids
  let isAuthorized = false;
  const docSnap = await adminDb.collection("installations").doc(installIdStr).get();
  if (docSnap.exists) {
    const data = docSnap.data();
    if (data?.adminUids && Array.isArray(data.adminUids) && data.adminUids.includes(uid)) {
      isAuthorized = true;
    }
  } else {
    const q = await adminDb
      .collection("installations")
      .where("installationId", "in", [installIdStr, !isNaN(installIdNum) ? installIdNum : installIdStr])
      .limit(1)
      .get();
    if (!q.empty) {
      const data = q.docs[0].data();
      if (data?.adminUids && Array.isArray(data.adminUids) && data.adminUids.includes(uid)) {
        isAuthorized = true;
      }
    }
  }

  if (!isAuthorized) {
    return NextResponse.json(
      { error: "Forbidden: You are not an administrator of this installation" },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const targetPlan = String(body.plan || "free").toLowerCase() as PlanTier;
    const resetCounter = Boolean(body.resetCounter);
    const billingCycle = body.billingCycle === "yearly" ? "yearly" : "monthly";

    if (targetPlan !== "free" && targetPlan !== "pro" && targetPlan !== "team") {
      return NextResponse.json(
        { error: 'Invalid plan. Allowed plans are "free", "pro", "team"' },
        { status: 400 }
      );
    }

    await setInstallationPlan(id, targetPlan, { resetCounter, billingCycle });

    const updatedQuota = await checkInstallationQuota(id);
    return NextResponse.json({
      success: true,
      message: `Installation ${id} updated to plan "${targetPlan}" (${billingCycle})`,
      plan: targetPlan,
      currentCount: updatedQuota.currentCount,
      monthlyLimit: updatedQuota.monthlyLimit,
      unlimited: updatedQuota.unlimited,
      resetMonth: updatedQuota.resetMonth,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to update plan: ${msg}` }, { status: 500 });
  }
}
