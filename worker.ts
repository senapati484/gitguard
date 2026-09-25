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
import { getInstallationOctokit } from "@/lib/github-app";
import {
  GITHUB_EVENTS_QUEUE,
  type GitHubEventJobData,
} from "@/lib/queues/github-events";
import { gitGuardGraph } from "@/agents/orchestrator";
import { recordRunToFirestore } from "@/agents/health-agent";

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

  // 1. Resolve repository owner and name
  const [repoOwner, repoShortName] =
    owner && repoName ? [owner, repoName] : repo.split("/");

  if (!repoOwner || !repoShortName) {
    throw new Error(`Invalid repo format "${repo}". Expected "owner/repo".`);
  }

  // 2. Fetch authenticated Octokit instance for this installation
  const octokit = await getInstallationOctokit(installationId);
  console.log(
    `[worker] Authenticated as GitHub App installation=${installationId} for ${repoOwner}/${repoShortName}`
  );

  let filesChanged = 0;
  let files: string[] = [];
  let diffContent = "";

  // 3. Pull diff and changed files via GitHub API
  if (event === "pull_request" && pullNumber) {
    console.log(
      `[worker] Fetching PR #${pullNumber} files and diff for ${repo}...`
    );

    // Pull changed files list
    const filesResp = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      {
        owner: repoOwner,
        repo: repoShortName,
        pull_number: pullNumber,
        per_page: 100,
      }
    );

    files = filesResp.data.map((f: { filename: string }) => f.filename);
    filesChanged = files.length;

    // Pull full unified diff
    const diffResp = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: repoOwner,
        repo: repoShortName,
        pull_number: pullNumber,
        headers: {
          accept: "application/vnd.github.v3.diff",
        },
      }
    );

    diffContent = typeof diffResp.data === "string" ? diffResp.data : "";
  } else {
    // Push event: compare before...sha or inspect commit
    const ZERO_SHA = "0000000000000000000000000000000000000000";
    const hasValidBefore = before && before !== ZERO_SHA;

    if (hasValidBefore) {
      const basehead = `${before}...${sha}`;
      console.log(
        `[worker] Comparing commits ${basehead} for ${repo}...`
      );

      // Fetch compare details (file metadata)
      const compareResp = await octokit.request(
        "GET /repos/{owner}/{repo}/compare/{basehead}",
        {
          owner: repoOwner,
          repo: repoShortName,
          basehead,
        }
      );

      const changedFilesList = compareResp.data.files ?? [];
      files = changedFilesList.map((f: { filename: string }) => f.filename);
      filesChanged = files.length;

      // Fetch unified diff for compare
      const diffResp = await octokit.request(
        "GET /repos/{owner}/{repo}/compare/{basehead}",
        {
          owner: repoOwner,
          repo: repoShortName,
          basehead,
          headers: {
            accept: "application/vnd.github.v3.diff",
          },
        }
      );

      diffContent = typeof diffResp.data === "string" ? diffResp.data : "";
    } else {
      console.log(`[worker] Fetching commit ${sha} diff for ${repo}...`);

      const commitResp = await octokit.request(
        "GET /repos/{owner}/{repo}/commits/{ref}",
        {
          owner: repoOwner,
          repo: repoShortName,
          ref: sha,
        }
      );

      const changedFilesList = commitResp.data.files ?? [];
      files = changedFilesList.map((f: { filename: string }) => f.filename);
      filesChanged = files.length;

      // Fetch unified diff for single commit
      const diffResp = await octokit.request(
        "GET /repos/{owner}/{repo}/commits/{ref}",
        {
          owner: repoOwner,
          repo: repoShortName,
          ref: sha,
          headers: {
            accept: "application/vnd.github.v3.diff",
          },
        }
      );

      diffContent = typeof diffResp.data === "string" ? diffResp.data : "";
    }
  }

  console.log(
    `[worker] Successfully retrieved diff for ${repo}: ${filesChanged} file(s) changed, ${diffContent.length} bytes diff`
  );
  if (files.length > 0) {
    console.log(`[worker] Changed files: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` (+${files.length - 5} more)` : ""}`);
  }

  // 4. Execute LangGraph State Graph (SecretAgent, BugAgent, SecurityAgent in parallel -> collision dialogue -> Sonnet Orchestrator)
  console.log(`[worker] Executing LangGraph orchestrator state graph...`);
  const graphResult = await gitGuardGraph.invoke({
    owner: repoOwner,
    repo: repoShortName,
    sha,
    diff: diffContent,
    pullNumber,
    octokit,
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
  }).catch((err) => {
    console.warn(`[worker] Failed to record run to Firestore:`, err);
  });

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
