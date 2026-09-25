import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookSignature } from "@/lib/verify-webhook";
import {
  handleMarketplacePurchaseEvent,
  type GitHubMarketplaceWebhookPayload,
} from "@/lib/plan-limits";

/**
 * POST /api/webhooks/marketplace
 *
 * Dedicated endpoint for GitHub Marketplace webhook deliveries.
 * (e.g. action: "purchased" | "changed" | "cancelled" | "pending_change")
 *
 * Verifies signature, updates the installation doc in Firestore mapping to the
 * same `plan` field Stripe uses, and enforces Marketplace precedence over Stripe.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.GITHUB_MARKETPLACE_WEBHOOK_SECRET || process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[marketplace-webhook] Missing webhook secret");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const event = req.headers.get("x-github-event") ?? "marketplace_purchase";
  const deliveryId = req.headers.get("x-github-delivery") ?? "unknown";

  const verification = verifyWebhookSignature(rawBody, signature, secret);
  if (!verification.ok) {
    console.warn(
      `[marketplace-webhook] Rejected delivery="${deliveryId}" event="${event}" reason="${verification.reason}"`
    );
    return NextResponse.json(
      { error: "Unauthorized", detail: verification.reason },
      { status: 401 }
    );
  }

  let payload: GitHubMarketplaceWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as GitHubMarketplaceWebhookPayload;
  } catch {
    console.warn(`[marketplace-webhook] Malformed JSON for delivery="${deliveryId}"`);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  console.log(
    `[marketplace-webhook] Received event="${event}" delivery="${deliveryId}" action="${payload.action}"`
  );

  try {
    const result = await handleMarketplacePurchaseEvent(payload);
    return NextResponse.json({
      received: true,
      event: "marketplace_purchase",
      action: payload.action,
      plan: result.effectivePlan,
      provider: result.provider,
      updatedCount: result.updatedCount,
    });
  } catch (err) {
    console.error("[marketplace-webhook] Error processing marketplace purchase event:", err);
    return NextResponse.json(
      { error: "Failed to process marketplace purchase", detail: String(err) },
      { status: 500 }
    );
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
