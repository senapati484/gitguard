import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUid } from "@/lib/auth-session";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { DashboardSidebarNav } from "@/components/dashboard/DashboardSidebarNav";

interface DashboardLayoutProps {
  children: ReactNode;
}

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
    <div className="flex h-screen max-h-screen overflow-hidden bg-slate-50/40 text-slate-900 antialiased selection:bg-slate-900 selection:text-white">
      {/* Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white md:flex h-full max-h-full overflow-hidden">
        {/* Brand Header */}
        <div className="flex h-16 shrink-0 items-center px-5 border-b border-slate-200">
          <Link href="/" className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center text-white shadow-sm shrink-0"
              style={{ width: "2rem", height: "2rem" }}
            >
              <svg
                className="w-4 h-4 shrink-0"
                width={16}
                height={16}
                style={{ width: "1rem", height: "1rem" }}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
                />
              </svg>
            </div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-base tracking-tight text-slate-900">
                GitGuard
              </span>
              <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                v1.2
              </span>
            </div>
          </Link>
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto">
          <DashboardSidebarNav />
        </div>

        {/* Sidebar Footer Link */}
        <div className="p-4 border-t border-slate-200 shrink-0">
          <a
            href="https://github.com/senapati484/gitguard"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between text-xs text-slate-500 hover:text-slate-900 transition-colors p-2 rounded-lg hover:bg-slate-50"
          >
            <span className="font-medium">GitHub Repository</span>
            <svg
              className="w-3.5 h-3.5 opacity-60"
              width={14}
              height={14}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
              />
            </svg>
          </a>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex flex-1 flex-col h-full min-w-0 overflow-hidden">
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white/95 backdrop-blur-md px-6">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-medium text-slate-700">Autonomous Guardrails Active</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-600 font-mono bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-md">
              uid: {uid.slice(0, 8)}…
            </span>
            <SignOutButton />
          </div>
        </header>

        <main className="flex-1 min-w-0 overflow-y-auto p-6 md:p-8">{children}</main>
      </div>
    </div>
  );
}

