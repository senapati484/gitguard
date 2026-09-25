import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/verify-webhook";
import { enqueueGitHubEvent, type GitHubEventJobData } from "@/lib/queues/github-events";

// ---------------------------------------------------------------------------
// GitHub Webhook Payload Interfaces
// ---------------------------------------------------------------------------

interface GitHubRepo {
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch?: string;
  private?: boolean;
}

interface GitHubInstallation {
  id: number;
}

interface PushPayload {
  ref: string;
  before: string;
  after: string;
  compare: string;
  repository: GitHubRepo;
  installation?: GitHubInstallation;
}

interface PullRequestPayload {
  action: string;
  number: number;
  pull_request: {
    head: { sha: string; ref: string };
    base: { ref: string };
    diff_url: string;
  };
  repository: GitHubRepo;
  installation?: GitHubInstallation;
}

/**
 * POST /api/webhooks/github
 *
 * Entry point for GitHub App webhook deliveries.
 *
 * Flow:
 *  1. Validate GITHUB_WEBHOOK_SECRET is set.
 *  2. Read raw request text.
 *  3. Verify X-Hub-Signature-256 with constant-time HMAC comparison.
 *  4. Parse event & payload.
 *  5. On push / pull_request events, enqueue { installationId, repo, sha, diffUrl } into BullMQ.
 *  6. Return 200 immediately so GitHub gets an instant ACK.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhook] GITHUB_WEBHOOK_SECRET is not configured");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const event = req.headers.get("x-github-event") ?? "unknown";
  const deliveryId = req.headers.get("x-github-delivery") ?? "unknown";

  const verification = verifyWebhookSignature(rawBody, signature, secret);
  if (!verification.ok) {
    console.warn(
      `[webhook] Rejected delivery="${deliveryId}" event="${event}" reason="${verification.reason}"`
    );
    return NextResponse.json(
      { error: "Unauthorized", detail: verification.reason },
      { status: 401 }
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    console.warn(`[webhook] Malformed JSON for delivery="${deliveryId}"`);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const installation = payload.installation as GitHubInstallation | undefined;
  const installationId = installation?.id ?? null;

  console.log(
    `[webhook] Received event="${event}" delivery="${deliveryId}" installation_id=${installationId ?? "none"}`
  );

  try {
    switch (event) {
      case "push": {
        const p = payload as unknown as PushPayload;
        if (!p.installation?.id) {
          console.warn(`[webhook] push event missing installation.id`);
          break;
        }

        const ZERO_SHA = "0000000000000000000000000000000000000000";
        if (p.after === ZERO_SHA) {
          console.log(`[webhook] Skipping branch deletion push`);
          break;
        }

        const jobData: GitHubEventJobData = {
          installationId: p.installation.id,
          repo: p.repository.full_name,
          sha: p.after,
          diffUrl: p.compare,
          event: "push",
          owner: p.repository.owner.login,
          repoName: p.repository.name,
          before: p.before,
          ref: p.ref,
        };

        await enqueueGitHubEvent(jobData);
        break;
      }

      case "pull_request": {
        const p = payload as unknown as PullRequestPayload;
        const validActions = ["opened", "synchronize", "reopened"];
        if (!validActions.includes(p.action)) {
          console.log(`[webhook] Ignoring pull_request action="${p.action}"`);
          break;
        }

        if (!p.installation?.id) {
          console.warn(`[webhook] pull_request event missing installation.id`);
          break;
        }

        const jobData: GitHubEventJobData = {
          installationId: p.installation.id,
          repo: p.repository.full_name,
          sha: p.pull_request.head.sha,
          diffUrl: p.pull_request.diff_url,
          event: "pull_request",
          owner: p.repository.owner.login,
          repoName: p.repository.name,
          pullNumber: p.number,
          action: p.action,
        };

        await enqueueGitHubEvent(jobData);
        break;
      }

      default:
        console.log(`[webhook] Unhandled event "${event}" - acknowledged`);
    }
  } catch (err) {
    console.error(
      `[webhook] Failed to enqueue job for event="${event}":`,
      err instanceof Error ? err.message : err
    );
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
