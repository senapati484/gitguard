"use client";

import { useState, useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { DashboardSidebarNav } from "@/components/dashboard/DashboardSidebarNav";
import { GitGuardLogo } from "@/components/brand/GitGuardLogo";

interface DashboardShellProps {
  uid: string;
  children: ReactNode;
}

export function DashboardShell({ uid, children }: DashboardShellProps) {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  // Restore desktop collapsed preference from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("gitguard_sidebar_collapsed");
      if (saved !== null) {
        setIsCollapsed(saved === "true");
      }
    } catch {}
  }, []);

  // Close mobile drawer on route changes
  useEffect(() => {
    setIsMobileOpen(false);
  }, [pathname]);

  const toggleCollapsed = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("gitguard_sidebar_collapsed", String(next));
      } catch {}
      return next;
    });
  };

  return (
    <div className="flex h-screen max-h-screen overflow-hidden bg-slate-50/40 text-slate-900 antialiased selection:bg-slate-900 selection:text-white">
      {/* ── Desktop Sidebar ──────────────────────────────────────────────── */}
      <aside
        className={`hidden md:flex shrink-0 flex-col border-r border-slate-200 bg-white h-full max-h-full overflow-hidden transition-all duration-300 ease-in-out ${
          isCollapsed ? "w-20" : "w-64"
        }`}
      >
        {/* Brand Header */}
        <div
          className={`flex h-16 shrink-0 items-center border-b border-slate-200 ${
            isCollapsed ? "justify-center px-2" : "justify-between px-5"
          }`}
        >
          {isCollapsed ? (
            <GitGuardLogo size="sm" showWordmark={false} linkHref="/" />
          ) : (
            <GitGuardLogo size="md" showWordmark={true} linkHref="/" />
          )}

          {/* Desktop collapse toggle button */}
          {!isCollapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              title="Collapse sidebar"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M18.75 19.5l-7.5-7.5 7.5-7.5m-6 15L5.25 12l7.5-7.5"
                />
              </svg>
            </button>
          )}
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto">
          <DashboardSidebarNav isCollapsed={isCollapsed} />
        </div>

        {/* Sidebar Footer Link & Bottom Expand/Collapse */}
        <div className="p-3 border-t border-slate-200 shrink-0 space-y-1">
          <a
            href="https://github.com/senapati484/gitguard"
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub Repository"
            className={`flex items-center rounded-lg text-xs text-slate-500 hover:text-slate-900 transition-colors hover:bg-slate-50 ${
              isCollapsed ? "justify-center p-2.5" : "justify-between p-2"
            }`}
          >
            <div className="flex items-center gap-2">
              <svg
                className="w-4 h-4 shrink-0 text-slate-700"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                />
              </svg>
              {!isCollapsed && <span className="font-medium">GitHub Repository</span>}
            </div>
            {!isCollapsed && (
              <svg
                className="w-3.5 h-3.5 opacity-60"
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
            )}
          </a>

          {/* Quick Expand Button when collapsed */}
          {isCollapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              title="Expand sidebar"
              className="w-full flex items-center justify-center p-2 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11.25 4.5l7.5 7.5-7.5 7.5m-6-15l7.5 7.5-7.5 7.5"
                />
              </svg>
            </button>
          )}
        </div>
      </aside>

      {/* ── Mobile Sidebar Drawer & Overlay ──────────────────────────────── */}
      {isMobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm transition-opacity"
            onClick={() => setIsMobileOpen(false)}
            aria-hidden="true"
          />

          {/* Slide-over panel */}
          <div className="relative w-72 max-w-[85vw] bg-white h-full shadow-2xl flex flex-col z-50 border-r border-slate-200">
            {/* Header */}
            <div className="flex h-16 shrink-0 items-center justify-between px-5 border-b border-slate-200">
              <GitGuardLogo size="md" showWordmark={true} linkHref="/" />
              <button
                type="button"
                onClick={() => setIsMobileOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors"
                aria-label="Close menu"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Navigation */}
            <div className="flex-1 overflow-y-auto">
              <DashboardSidebarNav
                isCollapsed={false}
                onItemClick={() => setIsMobileOpen(false)}
              />
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-slate-200 shrink-0">
              <a
                href="https://github.com/senapati484/gitguard"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between text-xs text-slate-600 hover:text-slate-950 p-2 rounded-lg hover:bg-slate-50 transition-colors"
              >
                <span className="font-medium">GitHub Repository</span>
                <svg
                  className="w-3.5 h-3.5 opacity-60"
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
          </div>
        </div>
      )}

      {/* ── Main Area ────────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col h-full min-w-0 overflow-hidden">
        {/* Sticky Top Header */}
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white/95 backdrop-blur-md px-4 sm:px-6">
          {/* Left: Mobile hamburger & Desktop toggle + Status badge */}
          <div className="flex items-center gap-3">
            {/* Mobile Hamburger Button */}
            <button
              type="button"
              onClick={() => setIsMobileOpen(true)}
              className="md:hidden p-2 -ml-1.5 rounded-lg text-slate-600 hover:text-slate-950 hover:bg-slate-100 transition-colors"
              aria-label="Open menu"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                />
              </svg>
            </button>

            {/* Mobile Brand Mark */}
            <div className="md:hidden">
              <GitGuardLogo size="sm" showWordmark={true} linkHref="/" />
            </div>

            {/* Desktop Toggle Button */}
            <button
              type="button"
              onClick={toggleCollapsed}
              title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="hidden md:flex items-center justify-center p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d={
                    isCollapsed
                      ? "M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
                      : "M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                  }
                />
              </svg>
            </button>

            {/* Status indicator */}
            <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500 pl-1 border-l border-slate-200">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              <span className="font-medium text-slate-700 whitespace-nowrap">
                Autonomous Guardrails Active
              </span>
            </div>
          </div>

          {/* Right: User UID badge & Sign Out */}
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="text-xs text-slate-600 font-mono bg-slate-100 border border-slate-200 px-2 sm:px-2.5 py-1 rounded-md max-w-[120px] sm:max-w-none truncate">
              uid: {uid.slice(0, 8)}…
            </span>
            <SignOutButton />
          </div>
        </header>

        {/* Scrollable Content Section */}
        <main className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
