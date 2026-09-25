"use client";

/**
 * components/auth/SignOutButton.tsx
 *
 * Client component: calls Firebase sign-out + DELETE /api/auth/session,
 * then redirects to /login.
 */
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";

export function SignOutButton() {
  const { signOut } = useAuth();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  return (
    <button
      onClick={handleSignOut}
      className={[
        "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground",
        "border border-border transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      ].join(" ")}
    >
      Sign out
    </button>
  );
}
