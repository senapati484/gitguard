/**
 * lib/queues/github-events.ts
 *
 * BullMQ queue definition and enqueue helpers for GitHub webhook events.
 *
 * Webhooks enqueue `{ installationId, repo, sha, diffUrl }` (+ context)
 * so that long-running operations (fetching diffs, static analysis, posting checks)
 * are processed asynchronously by worker.ts rather than blocking GitHub's 10s webhook timeout.
 */
import { Queue, type JobsOptions } from "bullmq";
import { getRedisConnection } from "@/lib/redis";

export const GITHUB_EVENTS_QUEUE = "github-events";

export interface GitHubEventJobData {
  /** GitHub App installation ID */
  installationId: number;
  /** Repository full name, e.g. "owner/repo" */
  repo: string;
  /** Commit SHA (head SHA for PR, after SHA for push) */
  sha: string;
  /** Diff or compare URL from GitHub payload */
  diffUrl: string;
  /** Event discriminator */
  event: "push" | "pull_request";
  /** Optional parsed fields for convenience */
  owner: string;
  repoName: string;
  /** Push specific */
  before?: string;
  ref?: string;
  /** Pull request specific */
  pullNumber?: number;
  action?: string;
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 5_000, // 5s, 10s, 20s
  },
  removeOnComplete: { age: 60 * 60 * 24 }, // 24h
  removeOnFail: { age: 60 * 60 * 24 * 7 }, // 7 days
};

const globalForQueue = globalThis as unknown as {
  __gitguard_events_queue?: Queue<GitHubEventJobData>;
};

export function getGithubEventsQueue(): Queue<GitHubEventJobData> {
  if (!globalForQueue.__gitguard_events_queue) {
    const queue = new Queue<GitHubEventJobData>(GITHUB_EVENTS_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });

    queue.on("error", (err: Error) => {
      const msg = err?.message || String(err);
      if (
        msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNRESET") ||
        msg.includes("Stream isn't writeable")
      ) {
        return; // Ignore idle serverless disconnects
      }
      console.warn("[queue] BullMQ Queue notice:", msg);
    });

    globalForQueue.__gitguard_events_queue = queue;
  }
  return globalForQueue.__gitguard_events_queue;
}

/**
 * Enqueue a GitHub event job onto the BullMQ github-events queue.
 */
export async function enqueueGitHubEvent(data: GitHubEventJobData): Promise<void> {
  const queue = getGithubEventsQueue();
  const safeRepo = data.repo.replace(/[/:]/g, "-");
  const jobId =
    data.event === "push"
      ? `push-${safeRepo}-${data.sha}`
      : `pr-${safeRepo}-${data.pullNumber}-${data.sha}`;

  await queue.add(data.event, data, { jobId });
  console.log(
    `[queue] Enqueued ${data.event} event for ${data.repo} (sha=${data.sha.slice(0, 7)}, installation=${data.installationId})`
  );
}
