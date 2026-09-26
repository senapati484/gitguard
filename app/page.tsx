import Link from "next/link";
import { getSessionUid } from "@/lib/auth-session";
import { GitGuardLogo } from "@/components/brand/GitGuardLogo";

export const metadata = {
  title: "GitGuard — Autonomous Code Security & Review Guardrails for GitHub",
  description:
    "Intercept leaked secrets, OWASP vulnerabilities, subtle logic defects, and SEO regressions on every commit and pull request.",
};

export default async function HomePage() {
  const uid = await getSessionUid().catch(() => null);

  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased selection:bg-slate-900 selection:text-white">
      {/* Top Header */}
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          {/* Logo Mark */}
          <GitGuardLogo size="md" showWordmark={true} linkHref="/" />

          {/* Navigation Links */}
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600">
            <a href="#features" className="hover:text-slate-900 transition-colors">
              Features
            </a>
            <a href="#agents" className="hover:text-slate-900 transition-colors">
              Agents
            </a>
            <a href="#health" className="hover:text-slate-900 transition-colors">
              Health Rubric
            </a>
            <Link href="/dashboard/pricing" className="hover:text-slate-900 transition-colors">
              Pricing
            </Link>
            <a
              href="https://github.com/senapati484/gitguard"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-slate-900 transition-colors flex items-center gap-1"
            >
              <span>GitHub</span>
              <svg className="w-3.5 h-3.5 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-3">
            {uid ? (
              <Link
                href="/dashboard"
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition-colors shadow-sm flex items-center gap-2"
              >
                <span>Dashboard</span>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
                >
                  Sign In
                </Link>
                <Link
                  href="/dashboard"
                  className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition-colors shadow-sm"
                >
                  Open Dashboard
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="pt-20 pb-16 px-4 sm:px-6 max-w-5xl mx-auto text-center">
        {/* Status Pill */}
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-slate-200 bg-slate-50 text-slate-700 text-xs font-medium mb-8">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          Autonomous multi-agent guardrails for GitHub repositories
        </div>

        {/* Hero Title */}
        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-slate-950 max-w-4xl mx-auto leading-[1.1]">
          Code security and correctness reviews before code merges
        </h1>

        {/* Subtitle */}
        <p className="mt-6 text-lg sm:text-xl text-slate-600 max-w-2xl mx-auto font-normal leading-relaxed">
          GitGuard analyzes every push and pull request with parallel specialized agents — detecting leaked tokens, OWASP SAST vulnerabilities, logic defects, and Web Vital regressions in seconds.
        </p>

        {/* Actions */}
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3.5">
          <Link
            href="/dashboard"
            className="px-5 py-3 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm transition-colors shadow-sm flex items-center gap-2"
          >
            <span>Launch Dashboard</span>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </Link>

          <Link
            href="/install"
            className="px-5 py-3 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-900 font-semibold text-sm transition-colors shadow-sm flex items-center gap-2"
          >
            <svg className="w-4 h-4 fill-current text-slate-900" viewBox="0 0 24 24">
              <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            <span>Install GitHub App</span>
          </Link>

          <Link
            href="/login"
            className="px-4 py-3 rounded-lg text-slate-500 hover:text-slate-900 text-sm font-medium transition-colors"
          >
            Instant Admin Sign-In →
          </Link>
        </div>

        {/* Authentic GitHub Check Run Simulation Box */}
        <div className="mt-14 text-left border border-slate-200 rounded-xl bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-xs">
                ✓
              </span>
              <span className="text-xs font-semibold text-slate-800">
                GitGuard / Orchestrator
              </span>
              <span className="text-xs text-slate-500 font-mono">senapati484/gitguard</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold">
                PASS
              </span>
              <span className="text-xs text-slate-400 font-mono">2.8s</span>
            </div>
          </div>

          <div className="p-6 divide-y divide-slate-100">
            {/* Run Metadata */}
            <div className="pb-4 flex flex-wrap items-center justify-between text-xs text-slate-600 gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-900">Commit Check</span>
                <span className="font-mono text-slate-500">push @ 5d15a3a</span>
                <span>• 2 files changed, 3.7 KB diff</span>
              </div>
              <div className="text-slate-500 font-mono">
                Installation ID: 164904329
              </div>
            </div>

            {/* Agent Inspection Items */}
            <div className="py-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border border-slate-200 rounded-lg p-3.5 bg-slate-50/50">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                    </svg>
                    <span className="text-xs font-semibold text-slate-900">SecretAgent</span>
                  </div>
                  <span className="text-[11px] font-mono px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700 font-semibold">
                    0 LEAKS
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  Scanned hunks with Shannon entropy. Verified no AWS, Stripe, GitHub, or OpenAI credentials in diff.
                </p>
              </div>

              <div className="border border-slate-200 rounded-lg p-3.5 bg-slate-50/50">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                    </svg>
                    <span className="text-xs font-semibold text-slate-900">BugAgent (Groq 120B)</span>
                  </div>
                  <span className="text-[11px] font-mono px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700 font-semibold">
                    0 DEFECTS
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  AST logic verification confirmed no off-by-one errors, race conditions, or unhandled exceptions.
                </p>
              </div>

              <div className="border border-slate-200 rounded-lg p-3.5 bg-slate-50/50">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    <span className="text-xs font-semibold text-slate-900">SecurityAgent (OWASP SAST)</span>
                  </div>
                  <span className="text-[11px] font-mono px-1.5 py-0.2 rounded bg-slate-100 text-slate-600 font-medium">
                    PRO TIER
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  Semgrep rules mapped to OWASP Top 10: SQL injection, SSRF, arbitrary file reads, and XSS patterns.
                </p>
              </div>

              <div className="border border-slate-200 rounded-lg p-3.5 bg-slate-50/50">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    <span className="text-xs font-semibold text-slate-900">HealthAgent Audit</span>
                  </div>
                  <span className="text-[11px] font-mono px-1.5 py-0.2 rounded bg-emerald-100 text-emerald-800 font-bold">
                    100 / 100 A+
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  Repository security health rated Pristine. Verified in Cloud Firestore with active SVG badge.
                </p>
              </div>
            </div>

            {/* Check Run Conclusion */}
            <div className="pt-3 flex items-center justify-between text-xs text-slate-500">
              <span>Final Synthesizer Verdict: <strong className="text-slate-900">ALLOW MERGE</strong></span>
              <span>Published directly to GitHub Checks API</span>
            </div>
          </div>
        </div>
      </section>

      {/* Core Capabilities */}
      <section id="features" className="py-20 border-t border-slate-200 bg-slate-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="max-w-2xl">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-950">
              Purpose-built security checks that developers respect
            </h2>
            <p className="mt-3 text-slate-600 text-base leading-relaxed">
              Linters only catch syntax formatting. GitGuard reasons through changed hunks to stop actual credential exposure, exploit paths, and regressions.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-6 bg-white border border-slate-200 rounded-xl shadow-sm space-y-3">
              <div className="w-9 h-9 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-900 font-bold">
                01
              </div>
              <h3 className="font-bold text-slate-950 text-base">Zero-Leak Secret Scanner</h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                Matches 80+ token signatures (AWS, Stripe, OpenAI, GitHub PATs) coupled with Shannon entropy calculations and <code className="text-xs bg-slate-100 px-1 py-0.5 rounded font-mono">.gitguardignore</code> whitelisting.
              </p>
            </div>

            <div className="p-6 bg-white border border-slate-200 rounded-xl shadow-sm space-y-3">
              <div className="w-9 h-9 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-900 font-bold">
                02
              </div>
              <h3 className="font-bold text-slate-950 text-base">Groq 120B AI Bug Review</h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                Reads unified diffs to catch subtle bugs, unhandled promise rejections, type mismatches, and suggests concrete replacement code blocks directly on GitHub pull requests.
              </p>
            </div>

            <div className="p-6 bg-white border border-slate-200 rounded-xl shadow-sm space-y-3">
              <div className="w-9 h-9 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-900 font-bold">
                03
              </div>
              <h3 className="font-bold text-slate-950 text-base">OWASP Top 10 SAST</h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                Applies Semgrep rulesets for SQL injection, server-side request forgery (SSRF), arbitrary code execution, and cross-site scripting (XSS) with zero local developer setup.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Quantitative Health Rubric Section */}
      <section id="health" className="py-20 border-t border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-950">
                Continuous Repository Health Scoring
              </h2>
              <p className="mt-3 text-slate-600 text-base leading-relaxed">
                Repositories are continuously evaluated on a 0 to 100 point rubric based on real audit history over the last 30 days.
              </p>

              <div className="mt-6 border border-slate-200 rounded-xl divide-y divide-slate-100 text-xs font-mono">
                <div className="flex items-center justify-between p-3.5 bg-slate-50">
                  <span className="text-slate-800 font-semibold font-sans">Baseline Quality Score</span>
                  <span className="font-bold text-slate-950">100 Points</span>
                </div>
                <div className="flex items-center justify-between p-3.5">
                  <span className="text-slate-600 font-sans">Confirmed Secret Leak</span>
                  <span className="text-rose-600 font-bold font-mono">−30 Pts per leak</span>
                </div>
                <div className="flex items-center justify-between p-3.5">
                  <span className="text-slate-600 font-sans">Critical Security Defect</span>
                  <span className="text-rose-600 font-bold font-mono">−25 Pts each</span>
                </div>
                <div className="flex items-center justify-between p-3.5">
                  <span className="text-slate-600 font-sans">High / Medium Severity Finding</span>
                  <span className="text-amber-600 font-bold font-mono">−15 / −5 Pts each</span>
                </div>
                <div className="flex items-center justify-between p-3.5">
                  <span className="text-slate-600 font-sans">Blocked Review Ratio Penalty</span>
                  <span className="text-slate-700 font-mono">Up to −15 Pts</span>
                </div>
              </div>
            </div>

            {/* Badge Preview & Code */}
            <div className="border border-slate-200 rounded-xl p-7 bg-slate-50 text-center space-y-6">
              <span className="text-xs font-mono text-slate-500 uppercase tracking-wider font-semibold">
                Live SVG Badge for README.md
              </span>

              {/* Rendered Badge */}
              <div className="py-2 flex justify-center">
                <div className="inline-flex rounded overflow-hidden shadow-sm border border-slate-800">
                  <div className="px-3 py-1 bg-slate-900 text-white font-mono text-xs font-semibold">
                    GitGuard Health
                  </div>
                  <div className="px-3 py-1 bg-emerald-500 text-white font-mono text-xs font-bold">
                    100/100 A+
                  </div>
                </div>
              </div>

              {/* Embed snippet */}
              <div className="text-left font-mono text-xs bg-white p-4 rounded-lg border border-slate-200 text-slate-800 space-y-2">
                <p className="text-[11px] font-sans font-semibold text-slate-500 uppercase">
                  Markdown Embed Snippet:
                </p>
                <code className="block overflow-x-auto text-slate-700 break-all select-all">
                  {`[![GitGuard Health](https://moisture-endowment-rising.ngrok-free.dev/api/badge/164904329/gitguard)](https://moisture-endowment-rising.ngrok-free.dev/dashboard)`}
                </code>
              </div>

              <Link
                href="/dashboard"
                className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-900 hover:text-slate-700 transition-colors"
              >
                <span>View your installation metrics</span>
                <span>→</span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Installation CTA */}
      <section className="py-16 border-t border-slate-200 bg-slate-900 text-white">
        <div className="max-w-4xl mx-auto px-4 text-center space-y-5">
          <h2 className="text-3xl font-extrabold tracking-tight">
            Protect your GitHub repositories in two minutes
          </h2>
          <p className="text-slate-300 text-base max-w-xl mx-auto">
            Zero configuration required. Authorize the GitHub App and get automated check runs on your very next git push.
          </p>
          <div className="pt-3 flex flex-wrap justify-center gap-3">
            <Link
              href="/dashboard"
              className="px-6 py-3 rounded-lg bg-white text-slate-950 font-bold text-sm hover:bg-slate-100 transition-colors shadow-sm"
            >
              Open Dashboard
            </Link>
            <Link
              href="/install"
              className="px-6 py-3 rounded-lg border border-slate-700 bg-slate-800 text-white font-semibold text-sm hover:bg-slate-750 transition-colors"
            >
              Install GitHub App
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-8 text-xs text-slate-500">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded bg-slate-900 flex items-center justify-center text-white font-bold text-[9px]">
              G
            </div>
            <span className="font-semibold text-slate-800">GitGuard.io</span>
            <span>— Automated GitHub Code Quality &amp; Security Guardrails</span>
          </div>

          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="hover:text-slate-900 transition-colors">
              Dashboard
            </Link>
            <Link href="/dashboard/pricing" className="hover:text-slate-900 transition-colors">
              Pricing
            </Link>
            <Link href="/login" className="hover:text-slate-900 transition-colors">
              Sign In
            </Link>
            <a
              href="https://github.com/senapati484/gitguard"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-slate-900 transition-colors"
            >
              Repository
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
