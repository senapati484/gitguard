/**
 * app/api/installations/[id]/policy/route.ts
 *
 * GET: Retrieves the Org-Wide Policy for this installation.
 * POST: Updates the Org-Wide Policy, gated to the Team plan, and logs a policy_change audit record.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUid } from "@/lib/auth-session";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { checkInstallationQuota } from "@/lib/plan-limits";
import {
  getInstallationPolicy,
  updateInstallationPolicy,
  type OrgPolicy,
  type AuditLogActor,
} from "@/lib/team-policy";

interface RouteParams {
  params: Promise<{ id: string }>;
}

async function checkAdminAuth(
  installationId: string,
  uid: string
): Promise<{ authorized: boolean; actor: AuditLogActor }> {
  const installIdStr = String(installationId);
  const installIdNum = Number(installationId);

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
      .where("installationId", "in", [
        installIdStr,
        !isNaN(installIdNum) ? installIdNum : installIdStr,
      ])
      .limit(1)
      .get();
    if (!q.empty) {
      const data = q.docs[0].data();
      if (data?.adminUids && Array.isArray(data.adminUids) && data.adminUids.includes(uid)) {
        isAuthorized = true;
      }
    }
  }

  let actor: AuditLogActor = { uid };
  try {
    const userRecord = await adminAuth.getUser(uid);
    actor = {
      uid,
      email: userRecord.email,
      displayName: userRecord.displayName || userRecord.email?.split("@")[0],
    };
  } catch {
    // fallback with basic uid
  }

  return { authorized: isAuthorized, actor };
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const uid = await getSessionUid();
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { authorized } = await checkAdminAuth(id, uid);
  if (!authorized) {
    return NextResponse.json(
      { error: "Forbidden: You are not an administrator of this installation" },
      { status: 403 }
    );
  }

  const quota = await checkInstallationQuota(id);
  const policy = await getInstallationPolicy(id);

  return NextResponse.json({
    installationId: id,
    plan: quota.plan,
    isTeamPlan: quota.plan === "team",
    policy,
  });
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const uid = await getSessionUid();
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { authorized, actor } = await checkAdminAuth(id, uid);
  if (!authorized) {
    return NextResponse.json(
      { error: "Forbidden: You are not an administrator of this installation" },
      { status: 403 }
    );
  }

  const quota = await checkInstallationQuota(id);
  if (quota.plan !== "team") {
    return NextResponse.json(
      {
        error: "Org-Wide Policies and Custom Secret Rules are exclusive to the Team plan. Please upgrade your plan.",
        upgradeRequired: true,
      },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const newPolicyData: Partial<OrgPolicy> = body.policy || body;

    const updated = await updateInstallationPolicy(id, newPolicyData, actor);

    return NextResponse.json({
      success: true,
      message: "Org-Wide Policy successfully saved and audit log updated",
      policy: updated,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to update policy: ${msg}` },
      { status: 500 }
    );
  }
}
