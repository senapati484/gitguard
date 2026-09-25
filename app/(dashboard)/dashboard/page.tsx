import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUid } from "@/lib/auth-session";
import { adminDb } from "@/lib/firebase-admin";
import { calculateHealthScore, type RepoRunRecord } from "@/lib/health-score";
import { getIgnoredAuditRecords, type IgnoredAuditRecord } from "@/lib/gitguard-ignore";
import type { PlanTier, BillingProvider } from "@/lib/plan-config";
import { getUserInstallationDocs } from "@/lib/installations";

export const metadata: Metadata = {
  title: "Dashboard | GitGuard",
  description: "Overview of your installations, security health, and recent PR checks.",
};

interface InstallationWithStats {
  id: string;
  installationId: number | string;
  accountLogin?: string;
  setupAction?: string;
  plan: PlanTier;
  billingProvider?: BillingProvider;
  recentRuns: RepoRunRecord[];
  healthScore: number;
  healthGrade: string;
  healthColor: string;
  healthStatus: string;
  passRate: number;
  totalRuns: number;
  whitelistedCount: number;
}

/**
 * app/(dashboard)/dashboard/page.tsx
 *
 * Lists all installations where the signed-in uid is in adminUids.
 * Displays per-installation health score (0-100) and recent review runs with verdict (PASS/WARN/BLOCK).
 * Surfaces .gitguardignore whitelisted reasons in an audit summary.
 */
export default async function DashboardPage() {
  const uid = await getSessionUid();
  if (!uid) redirect("/login");

  // 1. Fetch user's installations (with auto-claim for active GitHub installations)
  const installationDocs = await getUserInstallationDocs(uid);

  const rawInstallations = installationDocs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as {
      installationId: number | string;
      accountLogin?: string;
      setupAction?: string;
      plan?: PlanTier;
      billingProvider?: BillingProvider;
    }),
  }));

  // 2. Fetch runs and compute health scores per installation
  const installations: InstallationWithStats[] = await Promise.all(
    rawInstallations.map(async (inst) => {
      const installIdStr = String(inst.installationId);
      const installIdNum = Number(inst.installationId);

      // Query runs from top-level runs collection
      let runs: RepoRunRecord[] = [];
      try {
        const runsSnap = await adminDb
          .collection("runs")
          .where("installationId", "in", [installIdStr, !isNaN(installIdNum) ? installIdNum : installIdStr])
          .orderBy("createdAt", "desc")
          .limit(10)
          .get()
          .catch(() => {
            // Fallback if index is creating
            return adminDb
              .collection("runs")
              .where("installationId", "in", [installIdStr, !isNaN(installIdNum) ? installIdNum : installIdStr])
              .limit(10)
              .get();
          });

        if (runsSnap && !runsSnap.empty) {
          runs = runsSnap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as RepoRunRecord),
            createdAt: typeof d.data().createdAt === "number" ? d.data().createdAt : Date.now(),
          }));
        }
      } catch (err) {
        console.warn(`[dashboard] Error querying runs for installation ${installIdStr}:`, err);
      }

      // Sort by createdAt desc
      runs.sort((a, b) => b.createdAt - a.createdAt);

      const health = calculateHealthScore(runs);

      // Query whitelisted audit count
      let whitelistedCount = 0;
      try {
        const auditSnap = await adminDb
          .collection("ignored_audits")
          .where("installationId", "in", [installIdStr, !isNaN(installIdNum) ? installIdNum : installIdStr])
          .limit(20)
          .get()
          .catch(() => null);

        whitelistedCount = auditSnap ? auditSnap.size : 0;
      } catch {
        // non-fatal
      }

      return {
        id: inst.id,
        installationId: inst.installationId,
        accountLogin: inst.accountLogin || `Installation #${inst.installationId}`,
        setupAction: inst.setupAction || "active",
        plan: (inst.plan as PlanTier) || "free",
        billingProvider: inst.billingProvider,
        recentRuns: runs,
        healthScore: health.score,
        healthGrade: health.grade,
        healthColor: health.color,
        healthStatus: health.status,
        passRate: health.stats.passRate,
        totalRuns: health.stats.totalRuns,
        whitelistedCount,
      };
    })
  );

  // 3. Fetch global recent whitelisted findings for the audit summary
  const recentIgnoredAudits: IgnoredAuditRecord[] = await getIgnoredAuditRecords(
    undefined,
    undefined,
    6
  );

  // Calculate overall metrics
  const totalInstallations = installations.length;
  const avgHealthScore =
    totalInstallations > 0
      ? Math.round(
          installations.reduce((acc, curr) => acc + curr.healthScore, 0) / totalInstallations
        )
      : 100;
  const totalRunsAnalyzed = installations.reduce((acc, curr) => acc + curr.totalRuns, 0);
  const totalWhitelisted = installations.reduce((acc, curr) => acc + curr.whitelistedCount, 0);

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Security & Correctness Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Real-time monitoring across all GitHub App installations and automated review runs.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/install"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground shadow transition hover:opacity-90"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Connect Repository
          </Link>
        </div>
      </div>

      {/* Top Stats Overview */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Installations
            </p>
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
          </div>
          <p className="mt-2 text-3xl font-extrabold text-foreground">{totalInstallations}</p>
          <p className="text-xs text-muted-foreground mt-1">Authorized GitHub Apps</p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Health Score
            </p>
            <span
              className="px-2 py-0.5 rounded text-[11px] font-bold"
              style={{
                backgroundColor: avgHealthScore >= 90 ? "rgba(16, 185, 129, 0.15)" : "rgba(245, 158, 11, 0.15)",
                color: avgHealthScore >= 90 ? "#10b981" : "#f59e0b",
              }}
            >
              {avgHealthScore >= 90 ? "GRADE A" : "GRADE B"}
            </span>
          </div>
          <p className="mt-2 text-3xl font-extrabold text-foreground">
            {avgHealthScore}
            <span className="text-base font-normal text-muted-foreground">/100</span>
          </p>
          <p className="text-xs text-muted-foreground mt-1">30-day composite security rubric</p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              PR Checks Analyzed
            </p>
            <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="mt-2 text-3xl font-extrabold text-foreground">{totalRunsAnalyzed}</p>
          <p className="text-xs text-muted-foreground mt-1">Multi-agent orchestrator runs</p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Whitelisted Items
            </p>
            <span className="h-2 w-2 rounded-full bg-blue-500" />
          </div>
          <p className="mt-2 text-3xl font-extrabold text-foreground">{totalWhitelisted}</p>
          <p className="text-xs text-muted-foreground mt-1">Exemptions with audited reasons</p>
        </div>
      </div>

      {/* Installations List & Recent Runs */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Repositories & Installations</h2>
          <span className="text-xs text-muted-foreground">
            Showing {installations.length} installation(s)
          </span>
        </div>

        {installations.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/40 p-12 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 mb-4">
              <svg className="h-6 w-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
            </div>
            <h3 className="text-base font-semibold text-foreground">No installations found</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              You haven&apos;t connected GitGuard to any GitHub repositories yet. Install the GitHub App to begin scanning PRs.
            </p>
            <div className="mt-6">
              <Link
                href="/install"
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                Install GitGuard on GitHub
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {installations.map((inst) => (
              <div
                key={inst.id}
                className="rounded-xl border border-border bg-card overflow-hidden shadow-sm hover:border-border/80 transition"
              >
                {/* Installation Header */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border bg-muted/20 px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                      <svg className="h-5 w-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-foreground text-base">
                          {inst.accountLogin}
                        </h3>
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono bg-muted text-muted-foreground border border-border">
                          ID: {inst.installationId}
                        </span>
                        <Link
                          href="/dashboard/pricing"
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border uppercase tracking-wider transition hover:opacity-80 ${
                            inst.plan === "team"
                              ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                              : inst.plan === "pro"
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                              : "bg-muted text-muted-foreground border-border"
                          }`}
                        >
                          <span>{inst.plan} plan</span>
                          {inst.billingProvider === "marketplace" && (
                            <span className="text-[9px] text-purple-400 font-bold lowercase">
                              (marketplace)
                            </span>
                          )}
                        </Link>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Status: <span className="text-emerald-400 capitalize">{inst.setupAction}</span> • {inst.totalRuns} total run(s) recorded
                      </p>
                    </div>
                  </div>

                  {/* Health Score Pill & Repo Link */}
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg border border-border bg-card">
                      <div className="text-right">
                        <p className="text-[10px] font-medium uppercase text-muted-foreground">Health Score</p>
                        <p className="font-bold text-sm text-foreground">
                          {inst.healthScore}/100 <span className="text-xs font-semibold" style={{ color: inst.healthColor }}>({inst.healthGrade})</span>
                        </p>
                      </div>
                      <div
                        className="h-7 w-7 rounded-full flex items-center justify-center font-bold text-xs"
                        style={{
                          backgroundColor: `${inst.healthColor}20`,
                          color: inst.healthColor,
                          border: `1px solid ${inst.healthColor}40`,
                        }}
                      >
                        {inst.healthGrade}
                      </div>
                    </div>

                    <Link
                      href={`/repo/${inst.installationId}`}
                      className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition"
                    >
                      View Repo History & Trend
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </Link>
                  </div>
                </div>

                {/* Recent Runs Table */}
                <div className="p-6">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    Recent Review Runs & Verdicts
                  </h4>

                  {inst.recentRuns.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic py-3">
                      No review runs captured yet. Open a pull request in this repository to trigger GitGuard agents.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-border/60 text-muted-foreground">
                            <th className="pb-2 font-medium">Verdict</th>
                            <th className="pb-2 font-medium">Event / Target</th>
                            <th className="pb-2 font-medium">Commit SHA</th>
                            <th className="pb-2 font-medium">Agent Breakdown</th>
                            <th className="pb-2 font-medium text-right">Analyzed</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/40">
                          {inst.recentRuns.slice(0, 5).map((run) => {
                            const isPass = run.decision === "PASS";
                            const isWarn = run.decision === "WARN";

                            const verdictClass = isPass
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                              : isWarn
                              ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                              : "bg-red-500/10 text-red-400 border-red-500/20";

                            const dateStr = new Date(run.createdAt).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            });

                            return (
                              <tr key={run.id || run.sha} className="hover:bg-muted/10 transition">
                                <td className="py-2.5">
                                  <span
                                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${verdictClass}`}
                                  >
                                    {run.decision}
                                  </span>
                                </td>

                                <td className="py-2.5 font-medium text-foreground">
                                  {run.pullNumber ? (
                                    <span className="flex items-center gap-1">
                                      <svg className="h-3.5 w-3.5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                                      </svg>
                                      PR #{run.pullNumber}
                                    </span>
                                  ) : (
                                    <span className="text-muted-foreground">Push event</span>
                                  )}
                                </td>

                                <td className="py-2.5 font-mono text-muted-foreground">
                                  {run.sha ? run.sha.slice(0, 7) : "—"}
                                </td>

                                <td className="py-2.5">
                                  <div className="flex items-center gap-2">
                                    {(run.secretCount ?? 0) > 0 && (
                                      <span className="text-red-400 font-medium">
                                        🔒 {run.secretCount}
                                      </span>
                                    )}
                                    {((run.criticalCount ?? 0) + (run.highCount ?? 0)) > 0 && (
                                      <span className="text-amber-400 font-medium">
                                        🐛 {(run.criticalCount ?? 0) + (run.highCount ?? 0)}
                                      </span>
                                    )}
                                    {run.dialogueTriggered && (
                                      <span className="text-purple-400 font-medium text-[11px] bg-purple-500/10 px-1.5 py-0.5 rounded">
                                        🤝 Dialogue
                                      </span>
                                    )}
                                    {(run.secretCount ?? 0) === 0 &&
                                      ((run.criticalCount ?? 0) + (run.highCount ?? 0)) === 0 && (
                                        <span className="text-emerald-400">All clear</span>
                                      )}
                                  </div>
                                </td>

                                <td className="py-2.5 text-right text-muted-foreground font-mono">
                                  {dateStr}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Audit View: .gitguardignore Whitelist Surface */}
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              <h2 className="text-base font-semibold text-foreground">
                .gitguardignore Audit View
              </h2>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Whitelisted files and lines skipped by SecretAgent and BugAgent with verified reasons.
            </p>
          </div>

          <div className="rounded border border-blue-500/20 bg-blue-500/5 px-2.5 py-1 text-[11px] text-blue-400 font-mono">
            Rule format: &lt;pattern&gt; # reason: &lt;why it is ignored&gt;
          </div>
        </div>

        {recentIgnoredAudits.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-xs text-muted-foreground">
              No skipped items found yet. Rules in <code className="text-primary font-mono">.gitguardignore</code> requiring a valid reason (e.g. <code className="text-primary font-mono">tests/** # reason: mock fixture keys</code>) will automatically log their bypass rationale here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <th className="pb-2 font-medium">Agent</th>
                  <th className="pb-2 font-medium">File & Line</th>
                  <th className="pb-2 font-medium">Matched Pattern</th>
                  <th className="pb-2 font-medium">Required Reason String</th>
                  <th className="pb-2 font-medium text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {recentIgnoredAudits.map((audit) => (
                  <tr key={audit.id || `${audit.file}-${audit.timestamp}`} className="hover:bg-muted/10 transition">
                    <td className="py-2.5 font-medium">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold ${
                          audit.agent === "SecretAgent"
                            ? "bg-red-500/10 text-red-400 border border-red-500/20"
                            : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                        }`}
                      >
                        {audit.agent}
                      </span>
                    </td>

                    <td className="py-2.5 font-mono text-foreground">
                      {audit.file}{audit.line ? `:${audit.line}` : ""}
                    </td>

                    <td className="py-2.5 font-mono text-muted-foreground">
                      <span className="bg-muted px-1.5 py-0.5 rounded border border-border/80">
                        {audit.rulePattern}
                      </span>
                    </td>

                    <td className="py-2.5 font-medium text-foreground max-w-xs truncate">
                      &quot;{audit.reason}&quot;
                    </td>

                    <td className="py-2.5 text-right font-mono text-muted-foreground">
                      {new Date(audit.timestamp).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
