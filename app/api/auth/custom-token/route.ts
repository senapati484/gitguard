import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";

/**
 * POST /api/auth/custom-token
 *
 * Mints a Firebase custom token for instant admin sign-in.
 * Used for development / ngrok environments where Google OAuth popup
 * may be blocked by domain authorization restrictions.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json().catch(() => ({}));
    const email = body?.email || process.env.SMTP_EMAIL || "developer@gitguard.io";

    let userRecord;
    try {
      userRecord = await adminAuth.getUserByEmail(email);
    } catch {
      userRecord = await adminAuth.createUser({
        email,
        emailVerified: true,
        displayName: "GitGuard Administrator",
      });
    }

    const customToken = await adminAuth.createCustomToken(userRecord.uid, {
      admin: true,
    });

    return NextResponse.json({
      ok: true,
      customToken,
      uid: userRecord.uid,
      email: userRecord.email,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[auth/custom-token] Failed to mint token:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
