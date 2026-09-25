import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/verify-webhook";

// ---------------------------------------------------------------------------
// Minimal payload shape – only the fields we need at the routing layer.
// Individual event handlers will narrow further with their own types.
// ---------------------------------------------------------------------------
interface GitHubWebhookPayload {
  installation?: {
    id: number;
    account?: { login?: string; type?: string };
  };
  sender?: { login?: string };
  repository?: { full_name?: string };
  action?: string;
}

/**
 * POST /api/webhooks/github
 *
 * Entry point for all GitHub App webhook deliveries.
 *
 * Responsibilities (this file):
 *   1. Read raw body BEFORE any JSON parsing (signature is over the raw bytes).
 *   2. Verify X-Hub-Signature-256 via HMAC-SHA256 (constant-time).
 *   3. Parse X-GitHub-Event and log event type + installation.id.
 *   4. Return 200 { received: true } — no processing yet.
 *
 * @see https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Guard: secret must be present ──────────────────────────────────────
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhook] GITHUB_WEBHOOK_SECRET is not set");
    return NextResponse.json(
      { error: "Server misconfiguration" },
      { status: 500 }
    );
  }

  // ── 2. Read raw body (must happen before any framework body-parsing) ───────
  const rawBody = await req.text();

  // ── 3. Extract GitHub delivery headers ────────────────────────────────────
  const signature = req.headers.get("x-hub-signature-256");
  const event = req.headers.get("x-github-event") ?? "unknown";
  const deliveryId = req.headers.get("x-github-delivery") ?? "unknown";

  // ── 4. Verify HMAC-SHA256 signature (constant-time) ───────────────────────
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

  // ── 5. Parse JSON payload ─────────────────────────────────────────────────
  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as GitHubWebhookPayload;
  } catch {
    console.warn(`[webhook] Malformed JSON for delivery="${deliveryId}"`);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── 6. Log: event type + installation.id (always, before any routing) ─────
  const installationId = payload.installation?.id ?? null;
  console.log(
    `[webhook] event="${event}" delivery="${deliveryId}" installation_id=${installationId ?? "none"}`
  );

  // ── 7. Return 200 immediately — processing will be added per event later ──
  return NextResponse.json({ received: true }, { status: 200 });
}

// Reject non-POST requests with a clear error
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
