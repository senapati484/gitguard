import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { getSessionUid } from "@/lib/auth-session";

/**
 * GET /api/setup
 *
 * GitHub App "Setup URL" handler.
 *
 * Configure this URL in your GitHub App settings → "Setup URL (optional)":
 *   https://<your-domain>/api/setup
 *
 * GitHub will redirect here after install/update with these query params:
 *   - installation_id  (number)  — the new installation's ID
 *   - setup_action     (string)  — "install" | "update" | "delete"
 *   - code             (string)  — present only when OAuth is also configured
 *
 * What this handler does:
 *   1. Reads `installation_id` from the query string.
 *   2. Verifies the Firebase session cookie to identify the user.
 *   3. Writes / merges the uid into `installations/{id}.adminUids` in Firestore.
 *   4. Redirects to /dashboard.
 */
function getBaseUrl(req: NextRequest): string {
  const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (configuredAppUrl && !configuredAppUrl.includes("localhost")) {
    return configuredAppUrl.replace(/\/$/, "");
  }

  const forwardedProto = req.headers.get("x-forwarded-proto") || "http";
  const forwardedHost = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return req.nextUrl.origin;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const baseUrl = getBaseUrl(req);

  // If the browser landed on localhost:3000 but we have a public domain (ngrok),
  // immediately bounce to the public domain so session cookies and HTTPS are preserved.
  if (req.nextUrl.origin.includes("localhost") && !baseUrl.includes("localhost")) {
    const forwardUrl = new URL(req.nextUrl.pathname + req.nextUrl.search, baseUrl);
    return NextResponse.redirect(forwardUrl);
  }

  const { searchParams } = req.nextUrl;

  // ── 1. Parse required query params ─────────────────────────────────────────
  const rawId = searchParams.get("installation_id");
  const setupAction = searchParams.get("setup_action") ?? "install";

  if (!rawId || isNaN(Number(rawId))) {
    console.warn("[setup] Missing or invalid installation_id query param");
    return NextResponse.redirect(new URL("/dashboard", baseUrl));
  }
  const installationId = Number(rawId);

  // ── 2. Verify Firebase session cookie ──────────────────────────────────────
  const uid = await getSessionUid();
  if (!uid) {
    // Not signed in — send to login on baseUrl, preserving installation_id
    const loginUrl = new URL("/login", baseUrl);
    loginUrl.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  // ── 3. Write to Firestore ──────────────────────────────────────────────────
  try {
    const installRef = adminDb
      .collection("installations")
      .doc(String(installationId));

    await installRef.set(
      {
        installationId,
        // arrayUnion safely adds uid without duplicating it
        adminUids: FieldValue.arrayUnion(uid),
        setupAction,
        updatedAt: FieldValue.serverTimestamp(),
        // createdAt is set only on document creation (merge: true keeps existing value)
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(
      `[setup] installation_id=${installationId} uid=${uid} action=${setupAction}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[setup] Firestore write failed: ${message}`);
    // Still redirect — don't strand the user. A retry mechanism can be added later.
  }

  // ── 4. Redirect to dashboard ───────────────────────────────────────────────
  return NextResponse.redirect(new URL("/dashboard", baseUrl));
}
