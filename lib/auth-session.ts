/**
 * lib/auth-session.ts
 *
 * Server-side session cookie helpers (server-only).
 *
 * Flow:
 *   1. Client signs in with Google → gets a Firebase ID token.
 *   2. Client POSTs the ID token to /api/auth/session.
 *   3. Server calls createSessionCookie() → sets an httpOnly "__session" cookie.
 *   4. Subsequent server requests call getSessionUid() to verify the cookie.
 */
import "server-only";
import { cookies } from "next/headers";
import { adminAuth } from "@/lib/firebase-admin";

/** Name of the httpOnly session cookie. */
export const SESSION_COOKIE_NAME = "__session";

/** 5-day session lifetime in milliseconds (Firebase max is 14 days). */
const SESSION_DURATION_MS = 60 * 60 * 24 * 5 * 1000;

/**
 * Exchanges a short-lived Firebase ID token for a long-lived session cookie
 * and sets it as an httpOnly Secure cookie on the response.
 *
 * Call this from POST /api/auth/session after the client signs in.
 *
 * @param idToken - Firebase ID token from `user.getIdToken()` on the client.
 * @throws If the ID token is invalid or expired.
 */
export async function createSessionCookie(idToken: string): Promise<string> {
  return adminAuth.createSessionCookie(idToken, {
    expiresIn: SESSION_DURATION_MS,
  });
}

/**
 * Reads the "__session" cookie, verifies it with Firebase Admin, and returns
 * the decoded uid. Returns `null` if the cookie is absent or invalid.
 *
 * Safe to call from Server Components, middleware, and Route Handlers.
 * Uses `checkRevoked: true` to honour sign-out across devices.
 */
export async function getSessionUid(): Promise<string | null> {
  try {
    const cookieStore = cookies();
    const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
    if (!sessionCookie) return null;

    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true);
    return decoded.uid;
  } catch {
    return null;
  }
}

/**
 * Builds the Set-Cookie response header value for the session cookie.
 * Used in /api/auth/session after createSessionCookie().
 */
export function buildSessionCookieHeader(
  cookie: string,
  forceSecure?: boolean
): string {
  const isHttps =
    forceSecure !== undefined
      ? forceSecure
      : process.env.NODE_ENV === "production" ||
        Boolean(
          process.env.NEXT_PUBLIC_APP_URL &&
            process.env.NEXT_PUBLIC_APP_URL.startsWith("https://")
        );

  const parts = [
    `${SESSION_COOKIE_NAME}=${cookie}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${SESSION_DURATION_MS / 1000}`,
    "SameSite=Lax",
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}
