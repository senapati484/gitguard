import { NextRequest, NextResponse } from "next/server";

/**
 * middleware.ts
 *
 * Edge Middleware — lightweight route protection.
 *
 * Protects all routes under the (dashboard) group by checking for the
 * presence of the __session cookie.  The cookie's *validity* (signature,
 * expiry, revocation) is verified inside individual server components and
 * route handlers using adminAuth.verifySessionCookie() — middleware only
 * does the fast "cookie present?" check to avoid a full Admin SDK cold-start
 * on every edge request.
 *
 * Public routes (not protected): /login, /api/auth/session, /api/setup,
 * /api/webhooks/*, and all static assets.
 */

const SESSION_COOKIE = "__session";

/** Routes that are always public — no redirect even if unauthenticated. */
const PUBLIC_PATHS = [
  "/login",
  "/api/auth/session",
  "/api/setup",
  "/api/webhooks",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Pass through public routes and Next.js internals
  if (
    isPublic(pathname) ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  // Cookie presence check only — Admin SDK verification happens server-side
  const hasSession = req.cookies.has(SESSION_COOKIE);
  if (!hasSession) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Run on all routes except static files and Next.js internals
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
