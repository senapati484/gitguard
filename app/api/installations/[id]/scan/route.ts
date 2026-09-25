/**
 * app/api/installations/[id]/scan/route.ts
 *
 * Triggers an on-demand manual review scan for a repository in this installation.
 * Useful for one-off checks before opening a pull request or after disabling auto-scan on push.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUid } from "@/lib/auth-session";
import { adminDb } from "@/lib/firebase-admin";
import { getInstallationOctokit } from "@/lib/github-app";
import { enqueueGitHubEvent, type GitHubEventJobData } from "@/lib/queues/github-events";

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

  // 1. Authorize user as an installation admin
  let isAuthorized = false;
  let installationData: Record<string, unknown> | null = null;

  const docSnap = await adminDb.collection("installations").doc(installIdStr).get();
  if (docSnap.exists) {
    const data = docSnap.data();
    if (data?.adminUids && Array.isArray(data.adminUids) && data.adminUids.includes(uid)) {
      isAuthorized = true;
      installationData = data;
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
        installationData = data;
      }
    }
  }

  if (!isAuthorized) {
    return NextResponse.json(
      { error: "Forbidden: You are not an administrator of this installation" },
      { status: 403 }
    );
  }

  // 2. Parse request body
  let body: { repo?: string; branch?: string; sha?: string } = {};
  try {
    body = await req.json();
  } catch {
    // optional body
  }

  const octokit = await getInstallationOctokit(installIdNum);

  // 3. Resolve target repository
  let targetRepo = body.repo;
  if (!targetRepo) {
    // If not supplied, inspect recent runs or installation repositories
    const runsSnap = await adminDb
      .collection("runs")
      .where("installationId", "in", [installIdStr, !isNaN(installIdNum) ? installIdNum : installIdStr])
      .limit(5)
      .get()
      .catch(() => null);

    if (runsSnap && !runsSnap.empty) {
      targetRepo = runsSnap.docs[0].data().repo;
    }

    if (!targetRepo) {
      // Query GitHub for first accessible repo
      try {
        const ghRepos = await octokit.request("GET /installation/repositories");
        if (ghRepos.data.repositories.length > 0) {
          targetRepo = ghRepos.data.repositories[0].full_name;
        }
      } catch {
        // non-fatal
      }
    }

    if (!targetRepo && installationData?.accountLogin) {
      targetRepo = `${installationData.accountLogin}/gitguard`;
    }
  }

  if (!targetRepo) {
    return NextResponse.json(
      { error: "Could not resolve repository. Please specify { repo: 'owner/name' } in request." },
      { status: 400 }
    );
  }

  const [owner, repoName] = targetRepo.split("/");
  if (!owner || !repoName) {
    return NextResponse.json(
      { error: `Invalid repository format "${targetRepo}". Expected "owner/repo".` },
      { status: 400 }
    );
  }

  const branch = body.branch || "main";
  let targetSha = body.sha;

  // 4. Resolve commit SHA if not provided
  if (!targetSha) {
    try {
      const commitResp = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
        owner,
        repo: repoName,
        ref: branch,
      });
      targetSha = commitResp.data.sha;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `Failed to resolve latest commit on ${targetRepo} (${branch}): ${msg}` },
        { status: 404 }
      );
    }
  }

  // 5. Enqueue manual scan job
  const jobData: GitHubEventJobData = {
    installationId: installIdNum,
    repo: targetRepo,
    sha: targetSha,
    diffUrl: "",
    event: "push",
    owner,
    repoName,
    ref: `refs/heads/${branch}`,
  };

  await enqueueGitHubEvent(jobData);

  console.log(
    `[scan-api] Manually triggered review scan for ${targetRepo} @ ${targetSha.slice(0, 7)} (branch: ${branch}) by uid=${uid}`
  );

  return NextResponse.json({
    success: true,
    repo: targetRepo,
    branch,
    sha: targetSha,
    message: `Review scan successfully queued for ${targetRepo} @ ${targetSha.slice(0, 7)}`,
  });
}
