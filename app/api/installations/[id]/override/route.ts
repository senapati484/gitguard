/**
 * app/api/installations/[id]/override/route.ts
 *
 * POST: Records an authorized emergency verdict override (e.g. BLOCK -> PASS or WARN)
 * and writes an immutable audit log record documenting who, when, the previous verdict,
 * the target verdict, and the mandatory reason.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUid } from "@/lib/auth-session";
import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { logAuditEvent, type AuditLogActor } from "@/lib/audit-log";
import { checkInstallationQuota } from "@/lib/plan-limits";
import { getInstallationOctokit } from "@/lib/github-app";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
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

  const quota = await checkInstallationQuota(id);
  if (quota.plan !== "team") {
    return NextResponse.json(
      {
        error: "Verdict overrides and compliance governance are exclusive to the Team plan.",
        upgradeRequired: true,
      },
      { status: 403 }
    );
  }

  try {
    const body = await req.json();
    const {
      repo,
      sha,
      pullNumber,
      previousVerdict,
      newVerdict,
      reason,
    } = body;

    if (!reason || String(reason).trim().length < 5) {
      return NextResponse.json(
        { error: "A detailed justification reason (minimum 5 characters) is mandatory for overrides." },
        { status: 400 }
      );
    }

    if (!newVerdict || !["PASS", "WARN", "BLOCK"].includes(newVerdict)) {
      return NextResponse.json(
        { error: "Invalid newVerdict. Must be PASS, WARN, or BLOCK." },
        { status: 400 }
      );
    }

    let actor: AuditLogActor = { uid };
    try {
      const user = await adminAuth.getUser(uid);
      actor = {
        uid,
        email: user.email,
        displayName: user.displayName || user.email?.split("@")[0],
      };
    } catch {
      // fallback
    }

    // 1. Write immutable audit log record
    const auditId = await logAuditEvent({
      action: "verdict_override",
      actor,
      installationId: id,
      repo,
      sha,
      pullNumber: pullNumber ? Number(pullNumber) : undefined,
      description: `Manual verdict override: ${previousVerdict || "UNKNOWN"} ➔ ${newVerdict} by ${actor.email || actor.displayName || actor.uid}`,
      details: {
        previousVerdict: previousVerdict || "UNKNOWN",
        newVerdict,
        reason: String(reason).trim(),
        timestamp: Date.now(),
      },
    });

    // 2. Optionally update GitHub Check Run if sha and repo are provided
    if (repo && sha) {
      try {
        const [owner, repoName] = repo.split("/");
        if (owner && repoName) {
          const octokit = await getInstallationOctokit(Number(id));
          const conclusion = newVerdict === "BLOCK" ? "failure" : newVerdict === "WARN" ? "neutral" : "success";
          await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
            owner,
            repo: repoName,
            name: "GitGuard / Orchestrator",
            head_sha: sha,
            status: "completed",
            conclusion,
            output: {
              title: `GitGuard Verdict: ${newVerdict} (Manual Override)`,
              summary: `### 🛡️ Manual Verdict Override\n\nThis check run was manually updated from **${previousVerdict || "UNKNOWN"}** to **${newVerdict}** by **${actor.email || actor.displayName || "Admin"}**.\n\n**Justification Reason:**\n> ${reason}\n\n**Audit Log Reference ID:** \`${auditId}\``,
            },
          });
        }
      } catch (ghErr) {
        console.warn(`[override] Notice: GitHub check-run update skipped:`, ghErr);
      }
    }

    return NextResponse.json({
      success: true,
      auditId,
      message: `Verdict successfully overridden to ${newVerdict} and recorded in immutable audit log`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Override failed: ${msg}` }, { status: 500 });
  }
}
