import { NextRequest, NextResponse } from "next/server";
import { createSessionCookie, buildSessionCookieHeader } from "@/lib/auth-session";

/**
 * POST /api/auth/session
 *
 * Exchanges a Firebase ID token (from the client after Google sign-in) for
 * a long-lived httpOnly session cookie stored server-side.
 *
 * Body: { idToken: string }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let idToken: string;
  try {
    const body = await req.json();
    idToken = body?.idToken;
    if (typeof idToken !== "string" || !idToken) throw new Error("missing");
  } catch {
    return NextResponse.json({ error: "idToken is required" }, { status: 400 });
  }

  try {
    const sessionCookie = await createSessionCookie(idToken);

    const res = NextResponse.json({ ok: true }, { status: 200 });
    res.headers.set("Set-Cookie", buildSessionCookieHeader(sessionCookie));
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[auth/session] Failed to create session cookie:", message);
    return NextResponse.json(
      { error: "Failed to create session", detail: message },
      { status: 401 }
    );
  }
}

/**
 * DELETE /api/auth/session
 *
 * Clears the session cookie (sign-out).
 * The client should also call firebase.auth().signOut() independently.
 */
export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true }, { status: 200 });
  // Expire the cookie immediately
  res.headers.set(
    "Set-Cookie",
    "__session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax"
  );
  return res;
}
