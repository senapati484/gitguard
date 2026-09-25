/**
 * app/api/installations/[id]/audit-logs/route.ts
 *
 * GET: Queries the immutable audit logs for this installation.
 * Filterable by repo, action (policy_change, ignore_applied, verdict_override), and limit.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUid } from "@/lib/auth-session";
import { adminDb } from "@/lib/firebase-admin";
import { getAuditLogs, type AuditLogAction } from "@/lib/audit-log";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const uid = await getSessionUid();
  if (!uid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const installIdStr = String(id);
  const installIdNum = Number(id);

  // Authorize admin
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

  if (!isAuthorized) {
    return NextResponse.json(
      { error: "Forbidden: You are not an administrator of this installation" },
      { status: 403 }
    );
  }

  const url = new URL(req.url);
  const action = (url.searchParams.get("action") as AuditLogAction) || undefined;
  const repo = url.searchParams.get("repo") || undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);

  const logs = await getAuditLogs({
    installationId: id,
    action,
    repo,
    limit,
  });

  return NextResponse.json({
    installationId: id,
    count: logs.length,
    logs,
  });
}
