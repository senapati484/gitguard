import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

/**
 * Verifies the GitHub webhook signature using HMAC-SHA256.
 * @see https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */
function verifyGitHubSignature(
  payload: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) return false;

  const hmac = crypto.createHmac("sha256", secret);
  const digest = `sha256=${hmac.update(payload).digest("hex")}`;

  // Use timingSafeEqual to prevent timing attacks
  const sigBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);

  if (sigBuffer.length !== digestBuffer.length) return false;
  return crypto.timingSafeEqual(sigBuffer, digestBuffer);
}

/**
 * POST /api/webhooks/github
 *
 * Receives and processes incoming GitHub App webhook events.
 * Supported events (expand as needed):
 *   - push
 *   - pull_request
 *   - check_run / check_suite
 *   - installation / installation_repositories
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    console.error("[webhook] GITHUB_WEBHOOK_SECRET is not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const event = req.headers.get("x-github-event");
  const deliveryId = req.headers.get("x-github-delivery");

  // --- Signature Verification ---
  if (!verifyGitHubSignature(rawBody, signature, secret)) {
    console.warn(`[webhook] Invalid signature for delivery ${deliveryId}`);
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  console.log(`[webhook] Received event="${event}" delivery="${deliveryId}"`);

  // --- Event Routing ---
  switch (event) {
    case "push": {
      // TODO: Handle push events (e.g., trigger repo analysis)
      break;
    }
    case "pull_request": {
      // TODO: Handle PR events (e.g., run checks on open/sync)
      break;
    }
    case "check_run": {
      // TODO: Handle check run rerequested events
      break;
    }
    case "installation":
    case "installation_repositories": {
      // TODO: Handle app installation lifecycle events
      break;
    }
    default: {
      console.log(`[webhook] Unhandled event type: "${event}"`);
    }
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

// Reject non-POST requests
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
