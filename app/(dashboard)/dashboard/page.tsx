import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUid } from "@/lib/auth-session";
import { adminDb } from "@/lib/firebase-admin";

export const metadata: Metadata = {
  title: "Dashboard | GitGuard",
  description: "Overview of your repositories and security checks.",
};

/**
 * app/(dashboard)/dashboard/page.tsx  →  /dashboard
 *
 * Shows an overview of the user's installations and recent check summaries.
 * Redirects to /login if no valid session exists.
 */
export default async function DashboardPage() {
  const uid = await getSessionUid();
  if (!uid) redirect("/login");

  // Fetch this user's installations (server-side, no client round-trip)
  const snapshot = await adminDb
    .collection("installations")
    .where("adminUids", "array-contains", uid)
    .limit(20)
    .get();

  const installations = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as { installationId: number; setupAction?: string }),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Manage your GitHub App installations and review security check results.
        </p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: "Installations", value: installations.length },
          { label: "Open Alerts", value: "—" },
          { label: "Checks Run Today", value: "—" },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="rounded-lg border border-border bg-card p-6 shadow-sm"
          >
            <p className="text-sm font-medium text-muted-foreground">{label}</p>
            <p className="mt-2 text-3xl font-bold">{value}</p>
          </div>
        ))}
      </div>

      {/* Installations list */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="font-semibold">Installations</h2>
          <a
            href="/install"
            className="text-sm font-medium text-primary hover:underline"
          >
            + Add installation
          </a>
        </div>
        {installations.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No installations yet.{" "}
              <a href="/install" className="font-medium text-primary hover:underline">
                Install GitGuard on GitHub
              </a>{" "}
              to get started.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {installations.map((inst) => (
              <li key={inst.id} className="flex items-center justify-between px-6 py-4">
                <div>
                  <p className="font-mono text-sm font-medium">
                    ID: {inst.installationId}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {inst.setupAction ?? "install"}
                  </p>
                </div>
                <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                  Active
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
