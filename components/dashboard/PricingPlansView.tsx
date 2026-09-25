"use client";

/**
 * components/dashboard/PricingPlansView.tsx
 *
 * Interactive Pricing, Tier Comparison, and Demo Plan Switcher for GitGuard.
 * Supports testing Free (50 checks/mo, 4 basic agents) vs Pro/Team (unlimited, all 7 agents).
 */

import React, { useState } from "react";
import {
  PLAN_CONFIGS,
  type PlanTier,
  type InstallationPlanInfo,
} from "@/lib/plan-config";

export type { InstallationPlanInfo };

interface PricingPlansViewProps {
  installations: InstallationPlanInfo[];
  defaultInstallationId?: string | number;
}

export function PricingPlansView({
  installations,
  defaultInstallationId,
}: PricingPlansViewProps) {
  const [billingCycle, setBillingCycle] = useState<"monthly" | "yearly">("monthly");
  const [selectedInstId, setSelectedInstId] = useState<string>(
    String(defaultInstallationId || (installations[0]?.installationId ?? ""))
  );
  const [installationsState, setInstallationsState] = useState<InstallationPlanInfo[]>(installations);
  const [loadingPlan, setLoadingPlan] = useState<PlanTier | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const currentInst =
    installationsState.find((i) => String(i.installationId) === selectedInstId) ||
    installationsState[0];

  const currentPlan = currentInst?.plan || "free";

  async function handleSwitchPlan(targetPlan: PlanTier, resetCounter: boolean = false) {
    if (!currentInst) return;

    setLoadingPlan(targetPlan);
    setActionMessage(null);

    try {
      const res = await fetch(`/api/installations/${currentInst.installationId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: targetPlan,
          resetCounter,
          billingCycle,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update plan");
      }

      // Update local state
      setInstallationsState((prev) =>
        prev.map((inst) => {
          if (String(inst.installationId) === String(currentInst.installationId)) {
            return {
              ...inst,
              plan: targetPlan,
              monthlyChecksCount: data.currentCount ?? inst.monthlyChecksCount,
              monthlyChecksLimit: data.monthlyLimit ?? inst.monthlyChecksLimit,
              unlimited: Boolean(data.unlimited),
            };
          }
          return inst;
        })
      );

      setActionMessage(
        `✅ Successfully switched ${currentInst.accountLogin || `Installation #${currentInst.installationId}`} to ${targetPlan.toUpperCase()} plan (Demo Mode)!`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionMessage(`❌ Error: ${msg}`);
    } finally {
      setLoadingPlan(null);
    }
  }

  const freeConfig = PLAN_CONFIGS.free;
  const proConfig = PLAN_CONFIGS.pro;
  const teamConfig = PLAN_CONFIGS.team;

  return (
    <div className="space-y-10">
      {/* Banner Notice: Demo Mode & Upcoming Stripe */}
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-5 text-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary mt-0.5">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-foreground">Stripe Checkout Integration (Upcoming)</span>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20 uppercase tracking-wider">
                Demo Sandbox Active
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Production Stripe billing gateway is in preview. You can test one-click plan switching and agent gating limits directly on this device.
            </p>
          </div>
        </div>

        {/* Installation Selector Dropdown */}
        {installationsState.length > 0 && (
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <label htmlFor="inst-select" className="text-xs font-medium text-muted-foreground whitespace-nowrap">
              Active Installation:
            </label>
            <select
              id="inst-select"
              value={selectedInstId}
              onChange={(e) => setSelectedInstId(e.target.value)}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground focus:outline-none focus:ring-1 focus:ring-primary shadow-sm"
            >
              {installationsState.map((inst) => (
                <option key={inst.id} value={String(inst.installationId)}>
                  {inst.accountLogin || `Installation #${inst.installationId}`} ({inst.plan.toUpperCase()})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {actionMessage && (
        <div className="rounded-lg border border-border bg-card p-3 text-xs font-medium animate-fadeIn">
          {actionMessage}
        </div>
      )}

      {/* Header & Billing Cycle Switcher */}
      <div className="text-center space-y-4 max-w-2xl mx-auto">
        <h2 className="text-3xl font-extrabold tracking-tight text-foreground">
          Predictable Pricing for Autonomous Code Security
        </h2>
        <p className="text-sm text-muted-foreground">
          Start on our generous free tier with core secret detection and conventional commit automation, or unlock full multi-agent consensus and exploitability gatekeeping.
        </p>

        {/* Billing Switcher */}
        <div className="inline-flex items-center rounded-full border border-border bg-card p-1 shadow-sm">
          <button
            type="button"
            onClick={() => setBillingCycle("monthly")}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${
              billingCycle === "monthly"
                ? "bg-primary text-primary-foreground shadow"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Monthly Billing
          </button>
          <button
            type="button"
            onClick={() => setBillingCycle("yearly")}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition flex items-center gap-1.5 ${
              billingCycle === "yearly"
                ? "bg-primary text-primary-foreground shadow"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Yearly Billing
            <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.2 text-[10px] font-bold text-emerald-400">
              Save 17%
            </span>
          </button>
        </div>
      </div>

      {/* 3 Tier Cards */}
      <div className="grid gap-6 md:grid-cols-3 max-w-6xl mx-auto">
        {/* FREE TIER CARD */}
        <div
          className={`rounded-2xl border p-6 flex flex-col justify-between transition shadow-sm ${
            currentPlan === "free"
              ? "border-primary bg-card ring-1 ring-primary/50"
              : "border-border bg-card/60 hover:border-border/80"
          }`}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg text-foreground">{freeConfig.name}</h3>
              {currentPlan === "free" ? (
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-primary/10 text-primary border border-primary/20">
                  Current Plan
                </span>
              ) : (
                <span className="text-[10px] font-medium text-muted-foreground">Open Source</span>
              )}
            </div>

            <p className="text-xs text-muted-foreground">{freeConfig.tagline}</p>

            <div className="pt-2">
              <span className="text-3xl font-extrabold text-foreground">$0</span>
              <span className="text-xs text-muted-foreground ml-1">/ month forever</span>
            </div>

            {/* Quota Progress Bar */}
            {currentInst && (
              <div className="rounded-xl border border-border/80 bg-muted/20 p-3 text-xs space-y-1.5">
                <div className="flex justify-between font-medium">
                  <span className="text-muted-foreground">Monthly Checks:</span>
                  <span className="text-foreground">
                    {currentInst.monthlyChecksCount} / {currentInst.unlimited ? "∞" : currentInst.monthlyChecksLimit}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      currentInst.monthlyChecksCount >= 50 ? "bg-red-500" : "bg-primary"
                    }`}
                    style={{
                      width: `${Math.min(100, (currentInst.monthlyChecksCount / 50) * 100)}%`,
                    }}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground text-right">
                  Reset period: {currentInst.resetMonth}
                </p>
              </div>
            )}

            {/* Features List */}
            <div className="pt-4 border-t border-border space-y-2.5">
              <p className="text-xs font-semibold text-foreground uppercase tracking-wider">
                What&apos;s included:
              </p>
              <ul className="space-y-2 text-xs">
                {freeConfig.features.map((feat, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-muted-foreground">
                    <svg className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <span>{feat}</span>
                  </li>
                ))}
                {/* Gated items */}
                <li className="flex items-start gap-2 text-muted-foreground/60 line-through">
                  <svg className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  <span>Semgrep OWASP Top 10 SAST</span>
                </li>
                <li className="flex items-start gap-2 text-muted-foreground/60 line-through">
                  <svg className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  <span>SEO & Cumulative Layout Shift (CLS)</span>
                </li>
                <li className="flex items-start gap-2 text-muted-foreground/60 line-through">
                  <svg className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  <span>Consensus Dialogue arbitration</span>
                </li>
              </ul>
            </div>
          </div>

          <div className="pt-6">
            <button
              type="button"
              disabled={currentPlan === "free" || loadingPlan !== null}
              onClick={() => handleSwitchPlan("free")}
              className={`w-full rounded-lg py-2.5 text-xs font-semibold transition ${
                currentPlan === "free"
                  ? "bg-muted text-muted-foreground cursor-default"
                  : "border border-border bg-card text-foreground hover:bg-muted/40"
              }`}
            >
              {currentPlan === "free" ? "Active Free Tier" : "Downgrade to Free (Demo)"}
            </button>
          </div>
        </div>

        {/* PRO TIER CARD (RECOMMENDED) */}
        <div
          className={`rounded-2xl border p-6 flex flex-col justify-between transition shadow-md relative ${
            currentPlan === "pro"
              ? "border-emerald-500 bg-card ring-2 ring-emerald-500/50"
              : "border-primary/50 bg-card hover:border-primary"
          }`}
        >
          {/* Popular Tag */}
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span className="px-3 py-1 rounded-full text-[10px] font-bold bg-primary text-primary-foreground uppercase tracking-widest shadow">
              Most Popular
            </span>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between pt-1">
              <h3 className="font-bold text-lg text-foreground">{proConfig.name}</h3>
              {currentPlan === "pro" && (
                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    Active Plan
                  </span>
                  {currentInst?.billingProvider === "marketplace" && (
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-purple-500/10 text-purple-400 border border-purple-500/20" title="Marketplace billing active (prefers over Stripe)">
                      Marketplace
                    </span>
                  )}
                </div>
              )}
            </div>

            <p className="text-xs text-muted-foreground">{proConfig.tagline}</p>

            <div className="pt-2">
              <span className="text-3xl font-extrabold text-foreground">
                ${billingCycle === "yearly" ? proConfig.priceYearly : proConfig.priceMonthly}
              </span>
              <span className="text-xs text-muted-foreground ml-1">/ month</span>
              {billingCycle === "yearly" && (
                <p className="text-[11px] text-emerald-400 font-medium">Billed annually ($288/yr)</p>
              )}
            </div>

            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-400 font-medium flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span>Unlimited check runs • All 7 agents active</span>
            </div>

            {/* Features List */}
            <div className="pt-4 border-t border-border space-y-2.5">
              <p className="text-xs font-semibold text-foreground uppercase tracking-wider">
                Everything in Free, plus:
              </p>
              <ul className="space-y-2 text-xs">
                {proConfig.features.map((feat, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-foreground">
                    <svg className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <span>{feat}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="pt-6">
            <button
              type="button"
              disabled={currentPlan === "pro" || loadingPlan !== null}
              onClick={() => handleSwitchPlan("pro")}
              className={`w-full rounded-lg py-2.5 text-xs font-semibold shadow transition ${
                currentPlan === "pro"
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 cursor-default"
                  : "bg-primary text-primary-foreground hover:opacity-90"
              }`}
            >
              {loadingPlan === "pro"
                ? "Switching to Pro..."
                : currentPlan === "pro"
                ? "Active Pro Plan"
                : "Upgrade to Pro (Demo 1-Click)"}
            </button>
          </div>
        </div>

        {/* TEAM TIER CARD */}
        <div
          className={`rounded-2xl border p-6 flex flex-col justify-between transition shadow-sm ${
            currentPlan === "team"
              ? "border-blue-500 bg-card ring-2 ring-blue-500/50"
              : "border-border bg-card/60 hover:border-border/80"
          }`}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg text-foreground">{teamConfig.name}</h3>
              {currentPlan === "team" ? (
                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                  <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20">
                    Active Plan
                  </span>
                  {currentInst?.billingProvider === "marketplace" && (
                    <span className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-purple-500/10 text-purple-400 border border-purple-500/20" title="Marketplace billing active (prefers over Stripe)">
                      Marketplace
                    </span>
                  )}
                </div>
              ) : (
                <span className="text-[10px] font-medium text-muted-foreground">Organizations</span>
              )}
            </div>

            <p className="text-xs text-muted-foreground">{teamConfig.tagline}</p>

            <div className="pt-2">
              <span className="text-3xl font-extrabold text-foreground">
                ${billingCycle === "yearly" ? teamConfig.priceYearly : teamConfig.priceMonthly}
              </span>
              <span className="text-xs text-muted-foreground ml-1">/ month</span>
              {billingCycle === "yearly" && (
                <p className="text-[11px] text-blue-400 font-medium">Billed annually ($828/yr)</p>
              )}
            </div>

            <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-blue-400 font-medium flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
              <span>Multi-repo organization fleet governance</span>
            </div>

            {/* Features List */}
            <div className="pt-4 border-t border-border space-y-2.5">
              <p className="text-xs font-semibold text-foreground uppercase tracking-wider">
                Full enterprise capabilities:
              </p>
              <ul className="space-y-2 text-xs">
                {teamConfig.features.map((feat, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-foreground">
                    <svg className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <span>{feat}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="pt-6">
            <button
              type="button"
              disabled={currentPlan === "team" || loadingPlan !== null}
              onClick={() => handleSwitchPlan("team")}
              className={`w-full rounded-lg py-2.5 text-xs font-semibold shadow transition ${
                currentPlan === "team"
                  ? "bg-blue-500/20 text-blue-400 border border-blue-500/30 cursor-default"
                  : "border border-border bg-card text-foreground hover:bg-muted/40"
              }`}
            >
              {loadingPlan === "team"
                ? "Switching to Team..."
                : currentPlan === "team"
                ? "Active Team Plan"
                : "Upgrade to Team (Demo 1-Click)"}
            </button>
          </div>
        </div>
      </div>

      {/* Feature Comparison Matrix */}
      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm max-w-6xl mx-auto space-y-4">
        <h3 className="font-semibold text-base text-foreground">Multi-Agent Tier Matrix</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border/80 text-muted-foreground">
                <th className="pb-3 font-medium">Capability / Agent</th>
                <th className="pb-3 font-medium text-center">Free Tier</th>
                <th className="pb-3 font-medium text-center text-emerald-400">Pro Tier</th>
                <th className="pb-3 font-medium text-center text-blue-400">Team Tier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              <tr>
                <td className="py-2.5 font-medium text-foreground">Monthly PR & Push Checks</td>
                <td className="py-2.5 text-center text-muted-foreground">50 checks / mo</td>
                <td className="py-2.5 text-center font-bold text-emerald-400">Unlimited</td>
                <td className="py-2.5 text-center font-bold text-blue-400">Unlimited</td>
              </tr>
              <tr>
                <td className="py-2.5 font-medium text-foreground">SecretAgent (Gitleaks + AI)</td>
                <td className="py-2.5 text-center text-emerald-400">✓ Included</td>
                <td className="py-2.5 text-center text-emerald-400">✓ Included</td>
                <td className="py-2.5 text-center text-emerald-400">✓ Included</td>
              </tr>
              <tr>
                <td className="py-2.5 font-medium text-foreground">BugAgent (Hunk Scans)</td>
                <td className="py-2.5 text-center text-muted-foreground">Basic Annotations</td>
                <td className="py-2.5 text-center font-semibold text-emerald-400">1-Click Suggested Changes</td>
                <td className="py-2.5 text-center font-semibold text-blue-400">1-Click Suggested Changes</td>
              </tr>
              <tr>
                <td className="py-2.5 font-medium text-foreground">SecurityAgent (Semgrep OWASP SAST)</td>
                <td className="py-2.5 text-center text-muted-foreground/60">— Gated</td>
                <td className="py-2.5 text-center text-emerald-400">✓ Exploitability Reasoning</td>
                <td className="py-2.5 text-center text-emerald-400">✓ Exploitability Reasoning</td>
              </tr>
              <tr>
                <td className="py-2.5 font-medium text-foreground">SEOAgent (Meta, OG, CLS)</td>
                <td className="py-2.5 text-center text-muted-foreground/60">— Gated</td>
                <td className="py-2.5 text-center text-emerald-400">✓ Included</td>
                <td className="py-2.5 text-center text-emerald-400">✓ Included</td>
              </tr>
              <tr>
                <td className="py-2.5 font-medium text-foreground">Consensus Dialogue Arbitration</td>
                <td className="py-2.5 text-center text-muted-foreground/60">— Gated</td>
                <td className="py-2.5 text-center text-emerald-400">✓ Sonnet Arbiter</td>
                <td className="py-2.5 text-center text-emerald-400">✓ Sonnet Arbiter</td>
              </tr>
              <tr>
                <td className="py-2.5 font-medium text-foreground">Email & Slack Notifications</td>
                <td className="py-2.5 text-center text-muted-foreground/60">— Gated</td>
                <td className="py-2.5 text-center text-emerald-400">✓ BLOCK & WARN Alerts</td>
                <td className="py-2.5 text-center text-emerald-400">✓ BLOCK & WARN Alerts</td>
              </tr>
              <tr>
                <td className="py-2.5 font-medium text-foreground">.gitguardignore Audited Bypass</td>
                <td className="py-2.5 text-center text-emerald-400">✓ Included</td>
                <td className="py-2.5 text-center text-emerald-400">✓ Included</td>
                <td className="py-2.5 text-center text-emerald-400">✓ Custom Policies</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
