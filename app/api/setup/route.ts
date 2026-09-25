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
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;

  // ── 1. Parse required query params ─────────────────────────────────────────
  const rawId = searchParams.get("installation_id");
  const setupAction = searchParams.get("setup_action") ?? "install";

  if (!rawId || isNaN(Number(rawId))) {
    console.warn("[setup] Missing or invalid installation_id query param");
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }
  const installationId = Number(rawId);

  // ── 2. Verify Firebase session cookie ──────────────────────────────────────
  const uid = await getSessionUid();
  if (!uid) {
    // Not signed in — send to login, preserving the installation_id so we can
    // re-run setup after the user authenticates.
    const loginUrl = new URL("/login", req.url);
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
  return NextResponse.redirect(new URL("/dashboard", req.url));
}
