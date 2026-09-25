/**
 * worker.ts
 *
 * Standalone background worker process for GitGuard.
 * Consumes jobs from the "github-events" BullMQ queue.
 *
 * Deployment (Railway):
 *   Deploy as a separate Railway service with start command:
 *   `npm run worker`
 *
 * Job execution lifecycle:
 *   1. Webhook delivers push or pull_request event → route enqueues job into BullMQ.
 *   2. Worker picks up the job.
 *   3. Exchanges installationId for an authenticated Octokit client using the GitHub App private key.
 *   4. Fetches the PR files or commit compare diff via GitHub REST APIs.
 *   5. Prepares diff content for subsequent security scanning and AI analysis.
 */

import dotenv from "dotenv";
// Load local environment files if present (in development or non-Next.js environments)
dotenv.config({ path: ".env.local" });
dotenv.config();

import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "@/lib/redis";
import {
  getInstallationOctokit,
  getInstallationOctokitWithMeta,
} from "@/lib/github-app";
import {
  GITHUB_EVENTS_QUEUE,
  type GitHubEventJobData,
} from "@/lib/queues/github-events";
import { gitGuardGraph } from "@/agents/orchestrator";
import { recordRunToFirestore } from "@/agents/health-agent";
import { sendVerdictAlert } from "@/agents/slack-agent";
import {
  checkInstallationQuota,
  incrementInstallationCheckCount,
  type PlanTier,
} from "@/lib/plan-limits";
import { getInstallationPolicy, type OrgPolicy } from "@/lib/team-policy";
import { PipelineProfiler } from "@/lib/profiler";

interface ProcessedDiffResult {
  repo: string;
  sha: string;
  event: string;
  filesChanged: number;
  files: string[];
  diffLength: number;
  decision?: "PASS" | "WARN" | "BLOCK";
  secretCount?: number;
  bugCount?: number;
  securityCount?: number;
  dialogueTriggered?: boolean;
  suggestedCommitMessage?: string;
}

/**
 * Handles a single GitHub event job from the queue.
 */
async function processGitHubEvent(
  job: Job<GitHubEventJobData>
): Promise<ProcessedDiffResult> {
  const {
    installationId,
    repo,
    sha,
    diffUrl,
    event,
    owner,
    repoName,
    before,
    pullNumber,
  } = job.data;

  console.log(
    `\n[worker] Processing job id=${job.id} event=${event} repo=${repo} sha=${sha.slice(0, 7)}`
  );

  // Initialize pipeline latency profiler to monitor <5s median target
  const profiler = new PipelineProfiler(repo, sha);

  // 1. Resolve repository owner and name
  const [repoOwner, repoShortName] =
    owner && repoName ? [owner, repoName] : repo.split("/");

  if (!repoOwner || !repoShortName) {
    throw new Error(`Invalid repo format "${repo}". Expected "owner/repo".`);
  }

  // 2. Fetch authenticated Octokit instance for this installation (cached for 55m / ~1h validity)
  profiler.markTokenStart();
  const { octokit, cached } = await getInstallationOctokitWithMeta(installationId);
  profiler.markTokenEnd(cached);

  console.log(
    `[worker] Authenticated as GitHub App installation=${installationId} for ${repoOwner}/${repoShortName} (${
      cached ? "token CACHED ~1h" : "token FETCHED"
    })`
  );

  let filesChanged = 0;
  let files: string[] = [];
  let diffContent = "";

  // 3. Pull diff and changed files via GitHub API (Parallelized for <5s median latency)
  profiler.markDiffStart();
  if (event === "pull_request" && pullNumber) {
    console.log(
      `[worker] Fetching PR #${pullNumber} files and diff in parallel for ${repo}...`
    );

    const [filesResp, diffResp] = await Promise.all([
      octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
        owner: repoOwner,
        repo: repoShortName,
        pull_number: pullNumber,
        per_page: 100,
      }),
      octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner: repoOwner,
        repo: repoShortName,
        pull_number: pullNumber,
        headers: {
          accept: "application/vnd.github.v3.diff",
        },
      }),
    ]);

    files = filesResp.data.map((f: { filename: string }) => f.filename);
    filesChanged = files.length;
    diffContent = typeof diffResp.data === "string" ? diffResp.data : "";
  } else {
    // Push event: compare before...sha or inspect commit
    const ZERO_SHA = "0000000000000000000000000000000000000000";
    const hasValidBefore = before && before !== ZERO_SHA;

    if (hasValidBefore) {
      const basehead = `${before}...${sha}`;
      console.log(
        `[worker] Comparing commits ${basehead} for ${repo} in parallel...`
      );

      const [compareResp, diffResp] = await Promise.all([
        octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
          owner: repoOwner,
          repo: repoShortName,
          basehead,
        }),
        octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
          owner: repoOwner,
          repo: repoShortName,
          basehead,
          headers: {
            accept: "application/vnd.github.v3.diff",
          },
        }),
      ]);

      const changedFilesList = compareResp.data.files ?? [];
      files = changedFilesList.map((f: { filename: string }) => f.filename);
      filesChanged = files.length;
      diffContent = typeof diffResp.data === "string" ? diffResp.data : "";
    } else {
      console.log(`[worker] Fetching commit ${sha} diff for ${repo} in parallel...`);

      const [commitResp, diffResp] = await Promise.all([
        octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
          owner: repoOwner,
          repo: repoShortName,
          ref: sha,
        }),
        octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
          owner: repoOwner,
          repo: repoShortName,
          ref: sha,
          headers: {
            accept: "application/vnd.github.v3.diff",
          },
        }),
      ]);

      const changedFilesList = commitResp.data.files ?? [];
      files = changedFilesList.map((f: { filename: string }) => f.filename);
      filesChanged = files.length;
      diffContent = typeof diffResp.data === "string" ? diffResp.data : "";
    }
  }
  profiler.markDiffEnd();

  console.log(
    `[worker] Successfully retrieved diff for ${repo}: ${filesChanged} file(s) changed, ${diffContent.length} bytes diff`
  );
  if (files.length > 0) {
    console.log(`[worker] Changed files: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` (+${files.length - 5} more)` : ""}`);
  }

  // 4. Check Plan & Monthly Quota + Team Org-Wide Policy in parallel
  profiler.markQuotaStart();
  const [quota, fetchedPolicy] = await Promise.all([
    checkInstallationQuota(installationId),
    getInstallationPolicy(installationId).catch(() => undefined),
  ]);
  profiler.markQuotaEnd();

  console.log(
    `[worker] Installation ${installationId} tier: "${quota.plan.toUpperCase()}" (${quota.currentCount}/${quota.unlimited ? "∞" : quota.monthlyLimit} checks used in ${quota.resetMonth})`
  );

  if (!quota.allowed) {
    console.warn(`[worker] Monthly quota exceeded for installation ${installationId}: ${quota.reason}`);

    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner: repoOwner,
      repo: repoShortName,
      name: "GitGuard / Orchestrator",
      head_sha: sha,
      status: "completed",
      conclusion: "neutral",
      output: {
        title: "Monthly Free Plan Quota Reached (50/50 Checks)",
        summary: `### ⚠️ Monthly Check Limit Exceeded (Free Plan)\n\nThis installation has consumed its free tier allowance of **50 checks** for **${quota.resetMonth}**.\n\nTo unlock unlimited checks and full multi-agent scanning (**SecurityAgent OWASP SAST**, **SEOAgent Web Vitals**, and **Consensus Dialogue**), upgrade to **Pro** or **Team**.\n\nVisit your [GitGuard Dashboard](/dashboard/pricing) to manage plans.`,
      },
    });

    if (pullNumber) {
      await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner: repoOwner,
          repo: repoShortName,
          issue_number: pullNumber,
          body: `### ⚠️ GitGuard: Monthly Free Tier Quota Reached\n\nThis installation has reached its free limit of **50 checks** for **${quota.resetMonth}**.\n\n- **Free Plan**: 50 checks/month (SecretAgent, CommitAgent, basic BugAgent, Health score)\n- **Pro / Team**: Unlimited checks, Semgrep OWASP Top 10 SAST, Deep Exploitability Analysis, SEO & Web Vitals, and Dialogue arbitration.\n\n👉 Upgrade on your GitGuard dashboard to continue automated scanning.`,
        }
      ).catch(() => {});
    }

    return {
      repo,
      sha,
      event,
      filesChanged,
      files,
      diffLength: diffContent.length,
      decision: "WARN",
      secretCount: 0,
      bugCount: 0,
      securityCount: 0,
    };
  }

  // Increment monthly checks counter
  await incrementInstallationCheckCount(installationId, quota.installationDocId);

  // 5. Load Org-Wide Policy for Team plan installations
  let policy: OrgPolicy | undefined = undefined;
  if (quota.plan === "team") {
    policy = fetchedPolicy;
    if (policy) {
      console.log(
        `[worker] Active Team Policy for installation ${installationId}: ${
          policy.requiredAgents.length
        } required agent(s), block threshold ${
          policy.severityThresholds.blockThreshold
        }, debateMode: ${policy.debateMode ?? true}, ${
          policy.customSecretPatterns.length
        } custom secret rule(s).`
      );
    }
  }

  // 6. Execute LangGraph State Graph (gated according to plan tier)
  profiler.markAgentsStart();
  console.log(
    `[worker] Executing LangGraph orchestrator state graph (Plan: ${quota.plan.toUpperCase()}, DebateMode: ${
      quota.plan === "team" && (policy?.debateMode ?? true)
    })...`
  );
  const graphResult = await gitGuardGraph.invoke({
    owner: repoOwner,
    repo: repoShortName,
    sha,
    diff: diffContent,
    pullNumber,
    installationId,
    octokit,
    plan: quota.plan,
    policy,
    debateMode: policy?.debateMode,
    profiler,
  });

  console.log(
    `[worker] LangGraph execution finished. Verdict: ${graphResult.decision}`
  );

  const confirmedSecrets = (graphResult.secretFindings || []).filter((s) => s.confirmed);
  const criticalCount =
    (graphResult.bugFindings || []).filter((b) => b.severity === "critical").length +
    (graphResult.securityFindings || []).filter(
      (s) => s.isExploitable && s.severity === "critical"
    ).length;
  const highCount =
    (graphResult.bugFindings || []).filter((b) => b.severity === "high").length +
    (graphResult.securityFindings || []).filter(
      (s) => s.isExploitable && s.severity === "high"
    ).length;
  const mediumCount =
    (graphResult.bugFindings || []).filter((b) => b.severity === "medium").length +
    (graphResult.securityFindings || []).filter(
      (s) => !s.isExploitable || s.severity === "medium"
    ).length;
  const lowCount =
    (graphResult.bugFindings || []).filter((b) => b.severity === "low").length +
    (graphResult.securityFindings || []).filter((s) => s.severity === "low").length;

  // Persist run history to Firestore for 30-day health score & badge
  await recordRunToFirestore({
    installationId,
    repo,
    owner: repoOwner,
    repoName: repoShortName,
    sha,
    event,
    pullNumber,
    decision: graphResult.decision,
    secretCount: confirmedSecrets.length,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    dialogueTriggered: (graphResult.dialogueNotes || []).length > 0,
    seoScore: graphResult.seoScore,
    seoDefectCount: (graphResult.seoFindings || []).length,
  }).catch((err) => {
    console.warn(`[worker] Failed to record run to Firestore:`, err);
  });

  // Dispatch Email / Slack alert on BLOCK or WARN verdicts
  if (graphResult.decision === "BLOCK" || graphResult.decision === "WARN") {
    console.log(
      `[worker] Verdict is ${graphResult.decision} — dispatching alert notification for ${repo}...`
    );
    await sendVerdictAlert({
      installationId,
      repo,
      sha,
      decision: graphResult.decision,
      pullNumber,
      event,
      summary: graphResult.summaryComment,
      prComment: graphResult.summaryComment,
      secretFindings: graphResult.secretFindings,
      bugFindings: graphResult.bugFindings,
      securityFindings: graphResult.securityFindings,
    }).catch((err) => {
      console.warn(`[worker] Failed to dispatch verdict alert:`, err);
    });
  }

  return {
    repo,
    sha,
    event,
    filesChanged,
    files,
    diffLength: diffContent.length,
    decision: graphResult.decision,
    secretCount: confirmedSecrets.length,
    bugCount: (graphResult.bugFindings || []).length,
    securityCount: (graphResult.securityFindings || []).length,
    dialogueTriggered: (graphResult.dialogueNotes || []).length > 0,
    suggestedCommitMessage: graphResult.commitMessage,
  };
}

// ── Initialize BullMQ Worker ──────────────────────────────────────────────────

console.log(`[worker] Starting GitGuard background worker...`);
const redis = getRedisConnection();

const worker = new Worker<GitHubEventJobData>(
  GITHUB_EVENTS_QUEUE,
  processGitHubEvent,
  {
    connection: redis,
    concurrency: 5,
  }
);

worker.on("ready", () => {
  console.log(
    `[worker] Connected to Upstash Redis. Listening on queue "${GITHUB_EVENTS_QUEUE}"...`
  );
});

worker.on("completed", (job: Job<GitHubEventJobData>, result: ProcessedDiffResult) => {
  console.log(
    `[worker] Job ${job.id} COMPLETED for ${result.repo} (${result.filesChanged} files, ${result.diffLength} bytes)`
  );
});

worker.on("failed", (job: Job<GitHubEventJobData> | undefined, err: Error) => {
  console.error(
    `[worker] Job ${job?.id ?? "unknown"} FAILED: ${err.message}`,
    err.stack
  );
});

worker.on("error", (err: Error) => {
  console.error(`[worker] Redis or Worker error:`, err.message);
});

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

async function handleShutdown(signal: string) {
  console.log(`[worker] Received ${signal}. Shutting down gracefully...`);
  try {
    await worker.close();
    redis.disconnect();
    console.log(`[worker] Worker closed successfully.`);
    process.exit(0);
  } catch (err) {
    console.error(`[worker] Error during shutdown:`, err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
