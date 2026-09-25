import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUid } from "@/lib/auth-session";
import { SignOutButton } from "@/components/auth/SignOutButton";

interface DashboardLayoutProps {
  children: ReactNode;
}

const NAV_LINKS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/install", label: "Install" },
];

/**
 * Shared layout for the (dashboard) route group.
 * Performs server-side session verification — redirects to /login if invalid.
 */
export default async function DashboardLayout({
  children,
}: DashboardLayoutProps) {
  const uid = await getSessionUid();
  if (!uid) redirect("/login");

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card md:flex">
        <div className="flex h-16 items-center gap-2 border-b border-border px-5">
          {/* Shield icon */}
          <svg
            aria-hidden="true"
            className="h-6 w-6 text-primary"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
            />
          </svg>
          <span className="text-base font-bold tracking-tight">GitGuard</span>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={[
                "flex items-center rounded-md px-3 py-2 text-sm font-medium",
                "text-muted-foreground transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
              ].join(" ")}
            >
              {label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-card px-6">
          <span className="text-sm text-muted-foreground font-mono truncate">
            uid: {uid.slice(0, 12)}…
          </span>
          <SignOutButton />
        </header>

        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}

