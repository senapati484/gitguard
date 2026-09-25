import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUid } from "@/lib/auth-session";
import { adminDb } from "@/lib/firebase-admin";
import {
  calculateHealthScore,
  type RepoRunRecord,
} from "@/lib/health-score";
import {
  getIgnoredAuditRecords,
  type IgnoredAuditRecord,
} from "@/lib/gitguard-ignore";
import { HealthTrendChart, type HealthTrendPoint } from "@/components/dashboard/HealthTrendChart";

interface RepoPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: RepoPageProps): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Repository #${id} Health & History | GitGuard`,
    description: `Per-agent check run breakdown and 30-day health score trend line for installation #${id}.`,
  };
}

/**
 * app/(dashboard)/repo/[id]/page.tsx
 *
 * Repository detail view:
 *   - Per-agent Check Run history (SecretAgent, BugAgent, SecurityAgent, SEOAgent, Dialogue).
 *   - Recharts 30-day health-score trend line.
 *   - Dashboard Audit View surfacing .gitguardignore whitelisted items with required reasons.
 */
interface InstallationRecord {
  installationId: number | string;
  accountLogin?: string;
  adminUids?: string[];
  setupAction?: string;
}

export default async function RepoDetailPage({ params }: RepoPageProps) {
  const uid = await getSessionUid();
  if (!uid) redirect("/login");

  const { id } = await params;
  const installIdStr = String(id);
  const installIdNum = Number(id);

  // 1. Fetch installation document
  let installationData: InstallationRecord | null = null;

  // Try direct doc lookup first
  const docRef = await adminDb.collection("installations").doc(installIdStr).get();
  if (docRef.exists) {
    installationData = docRef.data() as unknown as InstallationRecord;
  } else {
    // Try query by installationId field
    const querySnap = await adminDb
      .collection("installations")
      .where("installationId", "in", [installIdStr, !isNaN(installIdNum) ? installIdNum : installIdStr])
      .limit(1)
      .get();

    if (!querySnap.empty) {
      installationData = querySnap.docs[0].data() as unknown as InstallationRecord;
    }
  }

  // Authorize user
  if (installationData?.adminUids && !installationData.adminUids.includes(uid)) {
    redirect("/dashboard");
  }

  const repoTitle = installationData?.accountLogin
    ? `${installationData.accountLogin}`
    : `Installation #${id}`;

  // 2. Fetch runs for this installation
  let runs: RepoRunRecord[] = [];

  try {
    const runsSnap = await adminDb
      .collection("runs")
      .where("installationId", "in", [installIdStr, !isNaN(installIdNum) ? installIdNum : installIdStr])
      .limit(50)
      .get();

    if (runsSnap && !runsSnap.empty) {
      runs = runsSnap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as RepoRunRecord),
        createdAt: typeof d.data().createdAt === "number" ? d.data().createdAt : Date.now(),
      }));
    }
  } catch (err) {
    console.warn(`[repo-page] Error querying runs for repo ${id}:`, err);
  }

  // Sort chronological for Recharts trend line
  runs.sort((a, b) => a.createdAt - b.createdAt);

  // 3. Compute 30-day composite health score
  const healthResult = calculateHealthScore(runs);

  // 4. Transform runs into Recharts trend data
  // Generate daily points or chronological run points
  const trendData: HealthTrendPoint[] = runs.map((run, idx) => {
    // Cumulative window score up to this point
    const windowSlice = runs.slice(Math.max(0, idx - 4), idx + 1);
    const sliceHealth = calculateHealthScore(windowSlice);

    return {
      date: new Date(run.createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      timestamp: run.createdAt,
      score: sliceHealth.score,
      verdict: run.decision,
      sha: run.sha,
      pullNumber: run.pullNumber,
      secrets: run.secretCount ?? 0,
      bugs: (run.criticalCount ?? 0) + (run.highCount ?? 0),
      security: run.criticalCount ?? 0,
    };
  });

  // If no trend data exists, provide a healthy starting anchor point
  if (trendData.length === 0) {
    trendData.push({
      date: "Today",
      timestamp: Date.now(),
      score: 100,
      verdict: "PASS",
    });
  }

  // 5. Fetch .gitguardignore whitelisted audit records for this installation
  const auditRecords: IgnoredAuditRecord[] = await getIgnoredAuditRecords(
    id,
    undefined,
    30
  );

  // Agent counts
  const totalSecrets = runs.reduce((acc, r) => acc + (r.secretCount || 0), 0);
  const totalBugs = runs.reduce((acc, r) => acc + (r.criticalCount || 0) + (r.highCount || 0), 0);
  const dialogueCount = runs.filter((r) => r.dialogueTriggered).length;

  return (
    <div className="space-y-8">
      {/* Navigation Breadcrumbs */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Link href="/dashboard" className="hover:text-foreground transition">
          Dashboard
        </Link>
        <span>/</span>
        <span className="text-foreground font-medium">{repoTitle}</span>
      </div>

      {/* Repository Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between border-b border-border pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{repoTitle}</h1>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-mono bg-primary/10 text-primary border border-primary/20">
              Installation #{id}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Continuous multi-agent code analysis • 30-day health scorecard • .gitguardignore audit logs
          </p>
        </div>

        {/* Health Score Badge Card */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm">
            <div
              className="flex h-12 w-12 items-center justify-center rounded-lg font-black text-xl shadow-inner"
              style={{
                backgroundColor: `${healthResult.color}15`,
                color: healthResult.color,
                border: `1.5px solid ${healthResult.color}40`,
              }}
            >
              {healthResult.grade}
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Composite Health
              </p>
              <div className="flex items-baseline gap-1.5">
                <span className="text-xl font-bold text-foreground">{healthResult.score}</span>
                <span className="text-xs text-muted-foreground">/ 100</span>
                <span
                  className="text-xs font-semibold ml-1"
                  style={{ color: healthResult.color }}
                >
                  {healthResult.status}
                </span>
              </div>
            </div>
          </div>

          <Link
            href={`/api/badge/${id}/${encodeURIComponent(repoTitle)}`}
            target="_blank"
            className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-3 text-xs font-medium text-foreground hover:bg-muted/40 transition shadow-sm"
          >
            <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            SVG Badge Embed
          </Link>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            PR Pass Rate
          </p>
          <div className="flex items-baseline gap-2 mt-2">
            <p className="text-3xl font-extrabold text-foreground">{healthResult.stats.passRate}%</p>
            <span className="text-xs text-emerald-400 font-medium">
              {healthResult.stats.passedRuns}/{healthResult.stats.totalRuns} passed
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Non-blocking merge safety</p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Secrets Prevented
          </p>
          <div className="flex items-baseline gap-2 mt-2">
            <p className="text-3xl font-extrabold text-foreground">{totalSecrets}</p>
            <span className="text-xs text-red-400 font-medium">SecretAgent</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Gitleaks SAST + AI filter</p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Bugs & Security Blockers
          </p>
          <div className="flex items-baseline gap-2 mt-2">
            <p className="text-3xl font-extrabold text-foreground">{totalBugs}</p>
            <span className="text-xs text-amber-400 font-medium">Critical/High</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Suggested changes generated</p>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Whitelisted Exemptions
          </p>
          <div className="flex items-baseline gap-2 mt-2">
            <p className="text-3xl font-extrabold text-foreground">{auditRecords.length}</p>
            <span className="text-xs text-blue-400 font-medium">.gitguardignore</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">Audited with documented reasons</p>
        </div>
      </div>

      {/* 30-Day Health-Score Trend Line (Recharts) */}
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <HealthTrendChart data={trendData} repoName={repoTitle} />
      </div>

      {/* Per-Agent Check Run Breakdown */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-foreground">Per-Agent Check Run History</h2>

        {/* Agent Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm flex items-center gap-1.5 text-foreground">
                <span>🔐</span> SecretAgent
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
                Gitleaks + AI
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Detects API keys, tokens, and private credentials. Filters mock tests and placeholders.
            </p>
            <div className="pt-2 border-t border-border flex justify-between text-xs">
              <span className="text-muted-foreground">Confirmed Leaks:</span>
              <span className="font-bold text-red-400">{totalSecrets}</span>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm flex items-center gap-1.5 text-foreground">
                <span>🐛</span> BugAgent
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                Suggested Changes
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Analyzes changed hunks for null derefs, unhandled promises, race conditions, and off-by-ones.
            </p>
            <div className="pt-2 border-t border-border flex justify-between text-xs">
              <span className="text-muted-foreground">Actionable Bugs:</span>
              <span className="font-bold text-amber-400">{totalBugs}</span>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm flex items-center gap-1.5 text-foreground">
                <span>🛡️</span> SecurityAgent
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                Semgrep SAST
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Scans OWASP Top 10 vulnerabilities with exploitability reasoning before merge gating.
            </p>
            <div className="pt-2 border-t border-border flex justify-between text-xs">
              <span className="text-muted-foreground">Arbitrated Collisions:</span>
              <span className="font-bold text-purple-400">{dialogueCount}</span>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm flex items-center gap-1.5 text-foreground">
                <span>🌐</span> SEOAgent
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Web Vitals
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Audits meta tags, Open Graph, image alt text, and cumulative layout shift (CLS).
            </p>
            <div className="pt-2 border-t border-border flex justify-between text-xs">
              <span className="text-muted-foreground">Avg SEO Score:</span>
              <span className="font-bold text-emerald-400">
                {healthResult.stats.avgSeoScore ? `${healthResult.stats.avgSeoScore}/100` : "100/100"}
              </span>
            </div>
          </div>
        </div>

        {/* Detailed Runs Log Table */}
        <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
          <div className="border-b border-border bg-muted/20 px-6 py-3.5 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Historical Check Runs
            </span>
            <span className="text-xs text-muted-foreground">
              {runs.length} check run(s) recorded in Firestore
            </span>
          </div>

          {runs.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-xs text-muted-foreground">
                No runs recorded yet for this installation. Open a pull request or push code to run GitGuard.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/10 text-muted-foreground">
                    <th className="py-3 px-6 font-medium">Verdict</th>
                    <th className="py-3 px-6 font-medium">Event / PR</th>
                    <th className="py-3 px-6 font-medium">Commit SHA</th>
                    <th className="py-3 px-6 font-medium">SecretAgent</th>
                    <th className="py-3 px-6 font-medium">BugAgent</th>
                    <th className="py-3 px-6 font-medium">SecurityAgent</th>
                    <th className="py-3 px-6 font-medium">SEO Score</th>
                    <th className="py-3 px-6 font-medium text-right">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {runs.slice().reverse().map((run) => {
                    const isPass = run.decision === "PASS";
                    const isWarn = run.decision === "WARN";

                    const verdictStyle = isPass
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : isWarn
                      ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                      : "bg-red-500/10 text-red-400 border-red-500/20";

                    return (
                      <tr key={run.id || run.sha} className="hover:bg-muted/10 transition">
                        <td className="py-3 px-6">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${verdictStyle}`}
                          >
                            {run.decision}
                          </span>
                        </td>

                        <td className="py-3 px-6 font-medium text-foreground">
                          {run.pullNumber ? (
                            <span className="flex items-center gap-1.5">
                              <svg className="h-3.5 w-3.5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                              </svg>
                              PR #{run.pullNumber}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">Push</span>
                          )}
                        </td>

                        <td className="py-3 px-6 font-mono text-muted-foreground">
                          {run.sha ? run.sha.slice(0, 7) : "—"}
                        </td>

                        <td className="py-3 px-6">
                          {(run.secretCount ?? 0) > 0 ? (
                            <span className="text-red-400 font-semibold">
                              ❌ {run.secretCount} leak(s)
                            </span>
                          ) : (
                            <span className="text-emerald-400">✓ Clean</span>
                          )}
                        </td>

                        <td className="py-3 px-6">
                          {((run.criticalCount ?? 0) + (run.highCount ?? 0)) > 0 ? (
                            <span className="text-amber-400 font-semibold">
                              ⚠️ {(run.criticalCount ?? 0) + (run.highCount ?? 0)} bug(s)
                            </span>
                          ) : (
                            <span className="text-emerald-400">✓ Clean</span>
                          )}
                        </td>

                        <td className="py-3 px-6">
                          {run.dialogueTriggered ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20 font-medium">
                              🤝 Consensus
                            </span>
                          ) : (
                            <span className="text-muted-foreground">OWASP Pass</span>
                          )}
                        </td>

                        <td className="py-3 px-6 font-mono">
                          {typeof run.seoScore === "number" ? (
                            <span
                              className={
                                run.seoScore >= 90
                                  ? "text-emerald-400 font-semibold"
                                  : "text-amber-400 font-semibold"
                              }
                            >
                              {run.seoScore}/100
                            </span>
                          ) : (
                            <span className="text-muted-foreground">N/A</span>
                          )}
                        </td>

                        <td className="py-3 px-6 text-right font-mono text-muted-foreground">
                          {new Date(run.createdAt).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
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

      {/* Dashboard Audit View: .gitguardignore Whitelist Logs */}
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
              <h2 className="text-base font-semibold text-foreground">
                .gitguardignore Audit View
              </h2>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Whitelisted lines & files bypassed by SecretAgent or BugAgent with verified reasons.
            </p>
          </div>

          <div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-1.5 text-xs text-blue-400">
            Mandatory format: <code className="font-mono">&lt;pattern&gt; # reason: &lt;explanation&gt;</code>
          </div>
        </div>

        {/* Explain Rule Requirement */}
        <div className="rounded-lg border border-border/80 bg-muted/10 p-4 text-xs space-y-2">
          <p className="font-semibold text-foreground flex items-center gap-1.5">
            <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            How .gitguardignore Whitelisting Works:
          </p>
          <p className="text-muted-foreground">
            To prevent accidental or unapproved security blind spots, GitGuard requires every rule in your repository&apos;s <code className="text-primary font-mono">.gitguardignore</code> to supply a valid reason string following <code className="text-primary font-mono"># reason: ...</code>. Rules without a documented reason are rejected by the parser and will <strong>not</strong> bypass checks.
          </p>
          <div className="bg-card rounded p-2.5 font-mono text-[11px] text-muted-foreground border border-border">
            # Valid examples:<br />
            tests/fixtures/** # reason: mock test data with dummy API keys<br />
            src/legacy/compat.ts # reason: approved backwards compatibility fallback
          </div>
        </div>

        {/* Audit Log Table */}
        {auditRecords.length === 0 ? (
          <div className="py-10 text-center border border-dashed border-border rounded-lg">
            <p className="text-xs text-muted-foreground">
              No whitelisted exemptions recorded for this repository yet. When files or lines match a valid <code className="text-primary font-mono">.gitguardignore</code> rule, their bypass reasons are automatically captured here for compliance audits.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <th className="pb-2.5 font-medium">Agent</th>
                  <th className="pb-2.5 font-medium">File & Line</th>
                  <th className="pb-2.5 font-medium">Matched Glob Pattern</th>
                  <th className="pb-2.5 font-medium">Mandatory Reason String</th>
                  <th className="pb-2.5 font-medium text-right">Audited At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {auditRecords.map((audit) => (
                  <tr key={audit.id || `${audit.file}-${audit.timestamp}`} className="hover:bg-muted/10 transition">
                    <td className="py-3">
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

                    <td className="py-3 font-mono text-foreground">
                      {audit.file}{audit.line ? `:${audit.line}` : ""}
                    </td>

                    <td className="py-3 font-mono text-muted-foreground">
                      <span className="bg-muted px-2 py-0.5 rounded border border-border">
                        {audit.rulePattern}
                      </span>
                    </td>

                    <td className="py-3 font-medium text-foreground">
                      <div className="max-w-md">
                        <p className="text-foreground">&quot;{audit.reason}&quot;</p>
                        {audit.findingSummary && (
                          <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                            Original finding: {audit.findingSummary}
                          </p>
                        )}
                      </div>
                    </td>

                    <td className="py-3 text-right font-mono text-muted-foreground">
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
