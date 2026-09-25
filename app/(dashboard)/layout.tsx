import type { ReactNode } from "react";

interface DashboardLayoutProps {
  children: ReactNode;
}

/**
 * Dashboard layout wrapping all routes in the (dashboard) group.
 * Add sidebar, topbar, and auth guards here.
 */
export default function DashboardLayout({ children }: DashboardLayoutProps) {
  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar placeholder — replace with <Sidebar /> component */}
      <aside className="hidden w-64 border-r border-border bg-card md:flex md:flex-col">
        <div className="flex h-16 items-center border-b border-border px-6">
          <span className="text-lg font-bold tracking-tight">GitGuard</span>
        </div>
        <nav className="flex-1 space-y-1 p-4">
          {/* TODO: Add <NavLink> items for dashboard routes */}
        </nav>
      </aside>

      {/* Main content area */}
      <div className="flex flex-1 flex-col">
        <header className="flex h-16 items-center border-b border-border bg-card px-6">
          {/* TODO: Add breadcrumbs, user menu, notifications */}
        </header>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
