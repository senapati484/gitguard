/**
 * lib/verify-webhook.ts
 *
 * HMAC-SHA256 signature verification for GitHub App webhooks.
 *
 * @see https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 *
 * Kept as a pure function with no Next.js / framework dependencies so it can
 * be unit-tested in isolation and reused across route handlers or middleware.
 */
import { createHmac, timingSafeEqual } from "crypto";

/**
 * Result of a webhook signature verification attempt.
 * `ok: false` always carries a human-readable reason.
 */
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Verifies a GitHub webhook `X-Hub-Signature-256` header against the raw
 * request body using HMAC-SHA256 and a constant-time comparison.
 *
 * @param rawBody  - The raw (un-parsed) UTF-8 request body string.
 * @param signature - The value of the `X-Hub-Signature-256` header,
 *                    expected to be in the form `sha256=<hex-digest>`.
 * @param secret   - The webhook secret configured in the GitHub App settings
 *                   (`GITHUB_WEBHOOK_SECRET`).
 * @returns        A {@link VerifyResult} discriminated union.
 *
 * @example
 * const result = verifyWebhookSignature(rawBody, sig, secret);
 * if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 401 });
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string
): VerifyResult {
  if (!signature) {
    return { ok: false, reason: "Missing X-Hub-Signature-256 header" };
  }

  if (!signature.startsWith("sha256=")) {
    return {
      ok: false,
      reason: "X-Hub-Signature-256 does not start with 'sha256='",
    };
  }

  // Compute expected digest
  const digest = `sha256=${createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("hex")}`;

  // Buffers must be the same byte-length for timingSafeEqual.
  // Encoding both as utf8 is safe here because the digest is pure hex ASCII.
  const sigBuf = Buffer.from(signature, "utf8");
  const digestBuf = Buffer.from(digest, "utf8");

  // Length mismatch itself leaks no useful timing info — differing lengths
  // immediately rule out a match regardless of the secret, so early-return
  // is fine here.
  if (sigBuf.length !== digestBuf.length) {
    return { ok: false, reason: "Signature length mismatch" };
  }

  const valid = timingSafeEqual(sigBuf, digestBuf);
  return valid ? { ok: true } : { ok: false, reason: "Signature mismatch" };
}
