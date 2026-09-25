import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dashboard | GitGuard",
  description: "Overview of your repositories and security checks.",
};

/**
 * Dashboard home page — shows repo overview, recent alerts, and check summaries.
 * Replace placeholder content with real data-fetching components.
 */
export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Welcome to GitGuard. Monitor your repositories and security checks here.
        </p>
      </div>

      {/* Stats row — wire up with real data */}
      <div className="grid gap-4 md:grid-cols-3">
        {["Repositories", "Open Alerts", "Checks Run Today"].map((label) => (
          <div
            key={label}
            className="rounded-lg border border-border bg-card p-6 shadow-sm"
          >
            <p className="text-sm font-medium text-muted-foreground">{label}</p>
            <p className="mt-2 text-3xl font-bold">—</p>
          </div>
        ))}
      </div>

      {/* Recent activity placeholder */}
      <div className="rounded-lg border border-border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">Recent Activity</h2>
        <p className="text-sm text-muted-foreground">No recent activity yet.</p>
      </div>
    </div>
  );
}
