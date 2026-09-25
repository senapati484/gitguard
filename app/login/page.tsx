/**
 * app/login/page.tsx
 *
 * Login page — Google sign-in only.
 * Accessible at /login; redirects to /dashboard after successful auth.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUid } from "@/lib/auth-session";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

export const metadata: Metadata = {
  title: "Sign In | GitGuard",
  description: "Sign in to GitGuard with your Google account.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const nextTarget = searchParams?.next || "/dashboard";

  // Already authenticated → skip the login screen
  const uid = await getSessionUid();
  if (uid) redirect(nextTarget);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo / wordmark */}
        <div className="space-y-2 text-center">
          <div className="inline-flex items-center justify-center rounded-xl bg-primary p-3">
            {/* Shield icon */}
            <svg
              aria-hidden="true"
              className="h-8 w-8 text-primary-foreground"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            Welcome to GitGuard
          </h1>
          <p className="text-sm text-muted-foreground">
            Automated security checks for your GitHub repositories.
          </p>
        </div>

        {/* Sign-in card */}
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
          <p className="text-center text-sm text-muted-foreground">
            Sign in to manage your installations and view security reports.
          </p>
          <GoogleSignInButton redirectTo={nextTarget} className="w-full justify-center" />
        </div>

        <p className="text-center text-xs text-muted-foreground">
          By continuing, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </main>
  );
}
