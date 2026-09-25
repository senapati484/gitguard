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
  primaryRepo?: string;
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

  const rawInstallations = installationDocs.map((doc) => {
    const data = doc.data() as {
      installationId: number | string;
      accountLogin?: string;
      setupAction?: string;
      plan?: PlanTier;
      billingProvider?: BillingProvider;
      primaryRepo?: string;
      repo?: string;
    };
    return {
      id: doc.id,
      ...data,
    };
  });

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
          .limit(20)
          .get();

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

      // Extract active repositories from installation doc or runs or fallback
      const activeRepos = Array.from(
        new Set(runs.map((r) => r.repo).filter((r): r is string => Boolean(r && r.trim())))
      );
      let primaryRepo = inst.primaryRepo || inst.repo || activeRepos[0];
      if (!primaryRepo && inst.accountLogin) {
        primaryRepo = `${inst.accountLogin}/gitguard`;
      }

      return {
        id: inst.id,
        installationId: inst.installationId,
        accountLogin: inst.accountLogin || `Installation #${inst.installationId}`,
        primaryRepo,
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

  // Filter out duplicate dead installations (e.g. 0 runs) if an active installation exists for the same account
  const activeInstallations = installations.filter((inst) => {
    if (inst.totalRuns > 0) return true;
    const hasActiveSibling = installations.some(
      (other) => other.installationId !== inst.installationId && other.accountLogin === inst.accountLogin && other.totalRuns > 0
    );
    return !hasActiveSibling;
  });

  // 3. Fetch global recent whitelisted findings for the audit summary
  const recentIgnoredAudits: IgnoredAuditRecord[] = await getIgnoredAuditRecords(
    undefined,
    undefined,
    6
  );

  // Calculate overall metrics
  const totalInstallations = activeInstallations.length;
  const avgHealthScore =
    totalInstallations > 0
      ? Math.round(
          activeInstallations.reduce((acc, curr) => acc + curr.healthScore, 0) / totalInstallations
        )
      : 100;
  const totalRunsAnalyzed = activeInstallations.reduce((acc, curr) => acc + curr.totalRuns, 0);
  const totalWhitelisted = activeInstallations.reduce((acc, curr) => acc + curr.whitelistedCount, 0);

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-950">
            Security &amp; Correctness Dashboard
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Real-time monitoring across all GitHub App installations and automated review runs.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/install"
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            <svg className="h-4 w-4 shrink-0" width={16} height={16} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Connect Repository
          </Link>
        </div>
      </div>

      {/* Top Stats Overview */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Installations
            </p>
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
          </div>
          <p className="mt-2 text-3xl font-extrabold text-slate-950">{totalInstallations}</p>
          <p className="text-xs text-slate-500 mt-1">Authorized GitHub Apps</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Health Score
            </p>
            <span
              className="px-2 py-0.5 rounded text-[11px] font-bold border"
              style={{
                backgroundColor: avgHealthScore >= 90 ? "#ecfdf5" : "#fffbeb",
                color: avgHealthScore >= 90 ? "#047857" : "#b45309",
                borderColor: avgHealthScore >= 90 ? "#a7f3d0" : "#fde68a",
              }}
            >
              {avgHealthScore >= 90 ? "GRADE A" : "GRADE B"}
            </span>
          </div>
          <p className="mt-2 text-3xl font-extrabold text-slate-950">
            {avgHealthScore}
            <span className="text-base font-normal text-slate-500">/100</span>
          </p>
          <p className="text-xs text-slate-500 mt-1">30-day composite security rubric</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              PR Checks Analyzed
            </p>
            <svg className="h-4 w-4 text-slate-900 shrink-0" width={16} height={16} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="mt-2 text-3xl font-extrabold text-slate-950">{totalRunsAnalyzed}</p>
          <p className="text-xs text-slate-500 mt-1">Multi-agent orchestrator runs</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              Whitelisted Items
            </p>
            <span className="h-2 w-2 rounded-full bg-slate-900" />
          </div>
          <p className="mt-2 text-3xl font-extrabold text-slate-950">{totalWhitelisted}</p>
          <p className="text-xs text-slate-500 mt-1">Exemptions with audited reasons</p>
        </div>
      </div>

      {/* Installations List & Recent Runs */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-950">Repositories &amp; Installations</h2>
          <span className="text-xs text-slate-500 font-mono">
            {activeInstallations.length} installation(s) connected
          </span>
        </div>

        {activeInstallations.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center shadow-sm">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-900 mb-4">
              <svg className="h-6 w-6" width={24} height={24} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
            </div>
            <h3 className="text-base font-semibold text-slate-900">No installations connected</h3>
            <p className="text-sm text-slate-500 mt-1 max-w-sm mx-auto">
              You haven&apos;t connected GitGuard to any GitHub repositories yet. Install the GitHub App to begin scanning PRs.
            </p>
            <div className="mt-6">
              <Link
                href="/install"
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 shadow-sm"
              >
                Install GitGuard on GitHub
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {activeInstallations.map((inst) => (
              <div
                key={inst.id}
                className="rounded-xl border border-slate-200 bg-white overflow-hidden shadow-sm hover:border-slate-300 transition-colors"
              >
                {/* Installation Header */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 bg-slate-50/70 px-6 py-4">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-slate-900 flex items-center justify-center text-white shadow-sm shrink-0">
                      <svg className="h-5 w-5" width={20} height={20} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                    </div>
                    <div>
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <a
                          href={`https://github.com/${inst.primaryRepo || inst.accountLogin}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-bold text-slate-950 text-base hover:text-slate-700 transition-colors flex items-center gap-1.5"
                        >
                          {inst.primaryRepo ? (
                            <>
                              <span className="text-slate-500 font-medium">{inst.primaryRepo.split("/")[0]} /</span>
                              <span className="text-slate-950 font-bold">{inst.primaryRepo.split("/")[1]}</span>
                            </>
                          ) : (
                            <span>{inst.accountLogin}</span>
                          )}
                          <svg className="w-3.5 h-3.5 opacity-50" width={14} height={14} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono bg-white text-slate-600 border border-slate-200">
                          ID: {inst.installationId}
                        </span>
                        <Link
                          href="/dashboard/pricing"
                          className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold border uppercase tracking-wider bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200 transition-colors"
                        >
                          <span>{inst.plan} plan</span>
                          {inst.billingProvider === "marketplace" && (
                            <span className="text-[9px] text-slate-500 font-bold lowercase">
                              (marketplace)
                            </span>
                          )}
                        </Link>
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        <span className="text-emerald-700 font-medium capitalize">{inst.setupAction}</span>
                        <span>•</span>
                        <span>{inst.totalRuns} total run(s) recorded</span>
                      </p>
                    </div>
                  </div>

                  {/* Health Score Pill & Repo Link */}
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white shadow-sm">
                      <div className="text-right">
                        <p className="text-[10px] font-semibold uppercase text-slate-500">Health</p>
                        <p className="font-bold text-sm text-slate-900">
                          {inst.healthScore}/100
                        </p>
                      </div>
                      <div
                        className="h-7 px-2 rounded font-bold text-xs flex items-center justify-center border"
                        style={{
                          backgroundColor: inst.healthScore >= 90 ? "#ecfdf5" : "#fffbeb",
                          color: inst.healthScore >= 90 ? "#047857" : "#b45309",
                          borderColor: inst.healthScore >= 90 ? "#a7f3d0" : "#fde68a",
                        }}
                      >
                        {inst.healthGrade}
                      </div>
                    </div>

                    <Link
                      href={`/repo/${inst.installationId}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-50 shadow-sm transition-colors"
                    >
                      <span>View History &amp; Trend</span>
                      <svg className="h-3.5 w-3.5" width={14} height={14} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </Link>
                  </div>
                </div>

                {/* Recent Runs Table */}
                <div className="p-6">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
                    Recent Review Runs &amp; Verdicts
                  </h3>

                  {inst.recentRuns.length === 0 ? (
                    <p className="text-xs text-slate-500 italic py-3">
                      No review runs captured yet. Open a pull request or push a commit in this repository to trigger GitGuard agents.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500">
                            <th className="pb-2.5 font-semibold">Verdict</th>
                            <th className="pb-2.5 font-semibold">Repository</th>
                            <th className="pb-2.5 font-semibold">Event / Target</th>
                            <th className="pb-2.5 font-semibold">Commit SHA</th>
                            <th className="pb-2.5 font-semibold">Agent Breakdown</th>
                            <th className="pb-2.5 font-semibold text-right">Analyzed</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {inst.recentRuns.slice(0, 5).map((run) => {
                            const isPass = run.decision === "PASS";
                            const isWarn = run.decision === "WARN";

                            const verdictClass = isPass
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : isWarn
                              ? "bg-amber-50 text-amber-700 border-amber-200"
                              : "bg-rose-50 text-rose-700 border-rose-200";

                            const dateStr = new Date(run.createdAt).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            });

                            const targetRepo = run.repo || inst.primaryRepo || "senapati484/gitguard";

                            return (
                              <tr key={run.id || run.sha} className="hover:bg-slate-50/70 transition-colors">
                                <td className="py-3">
                                  <span
                                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${verdictClass}`}
                                  >
                                    {run.decision}
                                  </span>
                                </td>

                                <td className="py-3 font-mono font-medium text-slate-900">
                                  <a
                                    href={`https://github.com/${targetRepo}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="hover:underline flex items-center gap-1.5 text-xs text-slate-900 font-semibold"
                                  >
                                    <svg className="w-3.5 h-3.5 text-slate-500 shrink-0" fill="currentColor" viewBox="0 0 16 16">
                                      <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.6-1.2-1.6 1.2a.25.25 0 0 1-.4-.2Z" />
                                    </svg>
                                    <span>{targetRepo}</span>
                                  </a>
                                </td>

                                <td className="py-3 font-semibold text-slate-900">
                                  {run.pullNumber ? (
                                    <a
                                      href={`https://github.com/${targetRepo}/pull/${run.pullNumber}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="flex items-center gap-1.5 hover:underline text-slate-900"
                                    >
                                      <svg className="h-3.5 w-3.5 text-slate-700" width={14} height={14} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                                      </svg>
                                      PR #{run.pullNumber}
                                    </a>
                                  ) : (
                                    <span className="text-slate-700 font-medium flex items-center gap-1">
                                      <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                                      </svg>
                                      Push to {targetRepo.split("/")[1] || targetRepo}
                                    </span>
                                  )}
                                </td>

                                <td className="py-3 font-mono text-slate-500">
                                  {run.sha ? (
                                    <a
                                      href={`https://github.com/${targetRepo}/commit/${run.sha}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="hover:text-slate-900 hover:underline"
                                    >
                                      {run.sha.slice(0, 7)}
                                    </a>
                                  ) : (
                                    "—"
                                  )}
                                </td>

                                <td className="py-3">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    {(run.secretCount ?? 0) > 0 && (
                                      <span className="text-rose-600 font-semibold bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded text-[11px]">
                                        🔒 {run.secretCount} leak
                                      </span>
                                    )}
                                    {((run.criticalCount ?? 0) + (run.highCount ?? 0)) > 0 && (
                                      <span className="text-amber-700 font-semibold bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded text-[11px]">
                                        🐛 {(run.criticalCount ?? 0) + (run.highCount ?? 0)} bug
                                      </span>
                                    )}
                                    {run.dialogueTriggered && (
                                      <span className="text-slate-700 font-medium text-[11px] bg-slate-100 border border-slate-200 px-1.5 py-0.5 rounded">
                                        🤝 Consensus
                                      </span>
                                    )}
                                    {(run.secretCount ?? 0) === 0 &&
                                      ((run.criticalCount ?? 0) + (run.highCount ?? 0)) === 0 && (
                                        <span className="text-emerald-700 font-medium text-[11px]">
                                          ✓ All checks passed
                                        </span>
                                      )}
                                  </div>
                                </td>

                                <td className="py-3 text-right text-slate-500 font-mono text-xs">
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
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-200 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-slate-900" />
              <h2 className="text-base font-bold text-slate-950">
                .gitguardignore Audit View
              </h2>
            </div>
            <p className="text-xs text-slate-600 mt-0.5">
              Whitelisted files and lines skipped by SecretAgent and BugAgent with verified reasons.
            </p>
          </div>

          <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-700 font-mono">
            Rule format: &lt;pattern&gt; # reason: &lt;why it is ignored&gt;
          </div>
        </div>

        {recentIgnoredAudits.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-xs text-slate-500">
              No skipped items found yet. Rules in <code className="text-slate-900 font-mono bg-slate-100 px-1 py-0.5 rounded">.gitguardignore</code> requiring a valid reason (e.g. <code className="text-slate-900 font-mono bg-slate-100 px-1 py-0.5 rounded">tests/** # reason: mock fixture keys</code>) will automatically log their bypass rationale here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="pb-2.5 font-semibold">Agent</th>
                  <th className="pb-2.5 font-semibold">File &amp; Line</th>
                  <th className="pb-2.5 font-semibold">Matched Pattern</th>
                  <th className="pb-2.5 font-semibold">Required Reason String</th>
                  <th className="pb-2.5 font-semibold text-right">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {recentIgnoredAudits.map((audit) => (
                  <tr key={audit.id || `${audit.file}-${audit.timestamp}`} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-2.5 font-medium">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border ${
                          audit.agent === "SecretAgent"
                            ? "bg-rose-50 text-rose-700 border-rose-200"
                            : "bg-amber-50 text-amber-700 border-amber-200"
                        }`}
                      >
                        {audit.agent}
                      </span>
                    </td>

                    <td className="py-2.5 font-mono text-slate-900">
                      {audit.file}{audit.line ? `:${audit.line}` : ""}
                    </td>

                    <td className="py-2.5 font-mono text-slate-600">
                      <span className="bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                        {audit.rulePattern}
                      </span>
                    </td>

                    <td className="py-2.5 font-medium text-slate-800 max-w-xs truncate">
                      &quot;{audit.reason}&quot;
                    </td>

                    <td className="py-2.5 text-right font-mono text-slate-500">
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
