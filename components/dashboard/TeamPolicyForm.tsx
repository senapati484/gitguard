"use client";

/**
 * components/dashboard/TeamPolicyForm.tsx
 *
 * Streamlined Org-Wide Guardrail & Policy Settings.
 * Aligned with the GitGuard website design:
 *   - Crisp monochrome aesthetics: white cards, slate-900 typography, subtle borders
 *   - Straightforward single-view controls: no complicated tab labyrinth
 *   - Connected directly to Firestore via /api/installations/[id]/policy
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  type OrgPolicy,
  type RequiredAgentName,
  type SeverityLevel,
  ALL_AGENT_NAMES,
  DEFAULT_ORG_POLICY,
} from "@/lib/team-policy-types";
import type { InstallationPlanInfo } from "@/lib/plan-config";

interface TeamPolicyFormProps {
  installations: InstallationPlanInfo[];
  defaultInstallationId?: string | number;
}

const AGENT_META: Record<
  RequiredAgentName,
  { label: string; icon: string; desc: string; badge: string }
> = {
  SecretAgent: {
    label: "SecretAgent",
    icon: "🔑",
    desc: "Detects leaked credentials, API tokens, and private keys with Shannon entropy and Gitleaks rules.",
    badge: "Zero-Leak",
  },
  BugAgent: {
    label: "BugAgent",
    icon: "🐛",
    desc: "AST-aware LLM analysis identifying logic bugs, null dereferences, and off-by-one errors with suggested fixes.",
    badge: "Groq 120B",
  },
  SecurityAgent: {
    label: "SecurityAgent",
    icon: "🛡️",
    desc: "Semgrep OWASP Top 10 SAST engine paired with Sonnet exploitability assessment and sink reachability analysis.",
    badge: "OWASP SAST",
  },
  CommitAgent: {
    label: "CommitAgent",
    icon: "📝",
    desc: "Enforces Conventional Commits formatting and synthesizes pull request release summaries.",
    badge: "Git Standards",
  },
  SEOAgent: {
    label: "SEOAgent",
    icon: "⚡",
    desc: "Audits React/Next.js and HTML diffs for Open Graph meta tags, image alt accessibility, and layout-shift inline styles.",
    badge: "Web Vitals",
  },
  HealthAgent: {
    label: "HealthAgent",
    icon: "📈",
    desc: "Aggregates 30-day run history into a composite 0-100 rubric score and exposes live cached SVG repository badges.",
    badge: "Scorecard",
  },
};

export function TeamPolicyForm({
  installations,
  defaultInstallationId,
}: TeamPolicyFormProps) {
  const [selectedInstId, setSelectedInstId] = useState<string>(
    String(defaultInstallationId || installations[0]?.installationId || "")
  );

  const currentInst =
    installations.find((i) => String(i.installationId) === selectedInstId) ||
    installations[0];

  // Policy state
  const [policy, setPolicy] = useState<OrgPolicy>(DEFAULT_ORG_POLICY);
  const [loadingPolicy, setLoadingPolicy] = useState<boolean>(false);
  const [savingPolicy, setSavingPolicy] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Manual one-off scan state
  const [triggerBranch, setTriggerBranch] = useState("main");
  const [triggeringScan, setTriggeringScan] = useState(false);
  const [triggerResult, setTriggerResult] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  async function handleTriggerManualScan() {
    setTriggeringScan(true);
    setTriggerResult(null);
    try {
      const res = await fetch(`/api/installations/${selectedInstId}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: triggerBranch }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to queue manual scan");
      }
      setTriggerResult({
        type: "success",
        text: `✓ Review scan successfully queued for ${data.repo} @ ${data.branch} (${data.sha.slice(0, 7)})!`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTriggerResult({ type: "error", text: msg });
    } finally {
      setTriggeringScan(false);
    }
  }

  // Fetch policy for selected installation
  const fetchPolicy = useCallback(async (instId: string) => {
    if (!instId) return;
    setLoadingPolicy(true);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/installations/${instId}/policy`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load policy");
      }
      if (data.policy) {
        setPolicy(data.policy);
      }
    } catch (err: unknown) {
      console.warn("Notice loading policy:", err);
      setPolicy(DEFAULT_ORG_POLICY);
    } finally {
      setLoadingPolicy(false);
    }
  }, []);

  useEffect(() => {
    if (selectedInstId) {
      fetchPolicy(selectedInstId);
    }
  }, [selectedInstId, fetchPolicy]);

  // Handle saving policy
  async function handleSavePolicy() {
    setSavingPolicy(true);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/installations/${selectedInstId}/policy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to save policy");
      }
      setPolicy(data.policy);
      setStatusMessage({
        type: "success",
        text: "Policy settings successfully saved and applied to your repository guardrails!",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMessage({ type: "error", text: msg });
    } finally {
      setSavingPolicy(false);
    }
  }

  function toggleAgent(agentName: RequiredAgentName) {
    setPolicy((prev) => {
      const exists = prev.requiredAgents.includes(agentName);
      const nextAgents = exists
        ? prev.requiredAgents.filter((a) => a !== agentName)
        : [...prev.requiredAgents, agentName];
      return { ...prev, requiredAgents: nextAgents };
    });
  }

  return (
    <div className="space-y-6">
      {/* Top Header & Installation Selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-slate-950">
              Team Guardrails &amp; Policy
            </h1>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Guardrails Active
            </span>
          </div>
          <p className="text-sm text-slate-600 mt-1">
            Configure required agent pipelines, multi-agent debate mode, and merge blocking thresholds.
          </p>
        </div>

        {/* Installation Selector or Badge */}
        {installations.length > 1 ? (
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-slate-500 whitespace-nowrap">
              Repository:
            </label>
            <select
              value={selectedInstId}
              onChange={(e) => setSelectedInstId(e.target.value)}
              className="bg-white border border-slate-200 text-slate-900 text-xs font-medium rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-slate-900 shadow-sm"
            >
              {installations.map((inst) => (
                <option key={inst.installationId} value={String(inst.installationId)}>
                  {inst.primaryRepo || (inst.accountLogin ? `${inst.accountLogin}/gitguard` : `Installation #${inst.installationId}`)} (ID: {inst.installationId})
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs font-mono px-3 py-1.5 rounded-lg bg-slate-100 border border-slate-200 text-slate-700">
            <span className="font-semibold font-sans text-slate-900">Repo:</span>
            <span>{currentInst?.primaryRepo || (currentInst?.accountLogin ? `${currentInst.accountLogin}/gitguard` : `Installation #${selectedInstId}`)}</span>
          </div>
        )}
      </div>

      {/* Status Alert Banner */}
      {statusMessage && (
        <div
          className={`p-4 rounded-xl text-xs font-medium border flex items-center justify-between gap-3 ${
            statusMessage.type === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-rose-50 border-rose-200 text-rose-800"
          }`}
        >
          <div className="flex items-center gap-2">
            <span>{statusMessage.type === "success" ? "✓" : "⚠️"}</span>
            <span>{statusMessage.text}</span>
          </div>
          <button
            onClick={() => setStatusMessage(null)}
            className="text-xs opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      )}

      {/* Card 0: Trigger Scope & One-Off Manual Scan */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <span className="text-lg">⚙️</span>
              <h2 className="text-base font-semibold text-slate-950">
                Trigger Scope &amp; Automated Checks
              </h2>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed max-w-2xl">
              Configure when GitGuard automatically analyzes code. You can disable automatic checks on raw <code>git push</code> commits to prevent interrupting your local development, and trigger manual one-off scans anytime.
            </p>
          </div>
        </div>

        {/* Push Toggle */}
        <div className="flex items-center justify-between p-4 rounded-lg bg-slate-50 border border-slate-200">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">Auto-scan on Git Push</span>
              <span
                className={`text-[10px] font-mono px-2 py-0.5 rounded font-semibold border ${
                  policy.scanOnPush
                    ? "bg-emerald-100 border-emerald-300 text-emerald-800"
                    : "bg-slate-200 border-slate-300 text-slate-700"
                }`}
              >
                {policy.scanOnPush ? "ENABLED" : "DISABLED (PRs Only)"}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              When disabled, GitGuard skips checks on every local <code>git push</code>. Pull requests remain protected.
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={Boolean(policy.scanOnPush)}
              onChange={(e) =>
                setPolicy((prev) => ({ ...prev, scanOnPush: e.target.checked }))
              }
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-slate-900"></div>
          </label>
        </div>

        {/* Manual One-Off Trigger */}
        <div className="pt-3 border-t border-slate-100">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold text-slate-900 uppercase tracking-wider">
                Run One-Off Review Scan
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Trigger an on-demand review check for any branch without making a pull request.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white shadow-sm">
                <span className="text-[11px] text-slate-500 font-mono">branch:</span>
                <input
                  type="text"
                  value={triggerBranch}
                  onChange={(e) => setTriggerBranch(e.target.value)}
                  placeholder="main"
                  className="text-xs font-mono text-slate-900 w-24 focus:outline-none bg-transparent"
                />
              </div>
              <button
                type="button"
                onClick={handleTriggerManualScan}
                disabled={triggeringScan}
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg shadow-sm transition-colors disabled:opacity-50 flex items-center gap-1.5 shrink-0"
              >
                {triggeringScan ? (
                  <>
                    <span className="animate-spin text-xs">⏳</span> Queuing...
                  </>
                ) : (
                  <>
                    <span>▶</span> Trigger Scan
                  </>
                )}
              </button>
            </div>
          </div>

          {triggerResult && (
            <div
              className={`mt-3 p-3 rounded-lg text-xs font-medium border flex items-center justify-between ${
                triggerResult.type === "success"
                  ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                  : "bg-rose-50 border-rose-200 text-rose-800"
              }`}
            >
              <span>{triggerResult.text}</span>
              <button
                type="button"
                onClick={() => setTriggerResult(null)}
                className="opacity-60 hover:opacity-100 font-bold"
              >
                ✕
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-950">
              Org-Wide Policy Enforcement
            </h2>
            <p className="text-xs text-slate-600 mt-1 leading-relaxed max-w-2xl">
              When enabled, all commits and pull requests must satisfy mandated agent checks and severity thresholds before merging.
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={policy.enabled}
              onChange={(e) =>
                setPolicy((prev) => ({ ...prev, enabled: e.target.checked }))
              }
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-slate-900"></div>
          </label>
        </div>
      </div>

      {/* Card 2: Multi-Agent Debate Mode */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <span className="text-lg">🗣️</span>
              <h2 className="text-base font-semibold text-slate-950">
                Multi-Agent Debate Mode
              </h2>
              <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                Auto-Consensus
              </span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed max-w-2xl">
              Executes a cross-examination dialogue round between SecretAgent, BugAgent, and SecurityAgent before issuing the final verdict to eliminate false positives and evaluate shared exploitability.
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={policy.debateMode ?? true}
              onChange={(e) =>
                setPolicy((prev) => ({ ...prev, debateMode: e.target.checked }))
              }
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-slate-900"></div>
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-4 border-t border-slate-100 text-xs">
          <div className="flex items-center gap-2 text-slate-600">
            <span className="text-emerald-600 font-semibold">⚡ Fast-Path Consensus:</span>
            <span>Instant &lt;1ms agreement on clean diffs</span>
          </div>
          <div className="flex items-center gap-2 text-slate-600">
            <span className="text-slate-900 font-semibold">⏱️ Latency Guard:</span>
            <span>Strictly capped at 2 rounds (&lt;5s target)</span>
          </div>
        </div>
      </div>

      {/* Card 3: Required Agent Pipeline */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-950">
            Mandatory Agent Pipeline
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            Select the agents mandated to run for every pull request. A check will not pass unless all required agents complete successfully.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 pt-2">
          {ALL_AGENT_NAMES.map((name) => {
            const meta = AGENT_META[name];
            const isSelected = policy.requiredAgents.includes(name);

            return (
              <div
                key={name}
                onClick={() => toggleAgent(name)}
                className={`cursor-pointer rounded-xl border p-4 transition-all ${
                  isSelected
                    ? "border-slate-900 bg-slate-50/80 shadow-sm"
                    : "border-slate-200 bg-white hover:border-slate-300 opacity-60"
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{meta.icon}</span>
                    <span className="text-sm font-semibold text-slate-900">
                      {meta.label}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    readOnly
                    className="rounded border-slate-300 text-slate-900 focus:ring-slate-900 h-4 w-4"
                  />
                </div>
                <p className="text-xs text-slate-600 mt-2 line-clamp-2 leading-relaxed">
                  {meta.desc}
                </p>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-600 font-medium">
                    {meta.badge}
                  </span>
                  <span className={`text-[11px] font-semibold ${isSelected ? "text-slate-900" : "text-slate-400"}`}>
                    {isSelected ? "Required" : "Optional"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Card 4: Severity & Merge Blocking Thresholds */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-950">
            Severity &amp; Merge Blocking Thresholds
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            Determine what degree of findings halt pull requests versus posting advisory comments.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
          {/* Block Threshold */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-900 flex items-center justify-between">
              <span>Minimum Severity to BLOCK:</span>
              <span className="font-mono text-slate-900 font-bold bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                {policy.severityThresholds.blockThreshold}
              </span>
            </label>
            <select
              value={policy.severityThresholds.blockThreshold}
              onChange={(e) =>
                setPolicy((prev) => ({
                  ...prev,
                  severityThresholds: {
                    ...prev.severityThresholds,
                    blockThreshold: e.target.value as SeverityLevel,
                  },
                }))
              }
              className="w-full bg-white border border-slate-200 text-slate-900 text-xs font-medium rounded-lg p-2.5 focus:ring-1 focus:ring-slate-900 focus:outline-none shadow-sm"
            >
              <option value="CRITICAL">CRITICAL (Only exploitable criticals block)</option>
              <option value="HIGH">HIGH (High &amp; Critical defects block - Recommended)</option>
              <option value="MEDIUM">MEDIUM (Strict: Medium, High, &amp; Critical block)</option>
              <option value="LOW">LOW (Zero Tolerance: All defects block)</option>
            </select>
            <p className="text-[11px] text-slate-500">
              Findings at or above this level trigger a <code>BLOCK</code> verdict and fail the GitHub Check Run.
            </p>
          </div>

          {/* Zero-Tolerance Secret Leaks */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-900 block">
              Zero-Tolerance Secret Leaks:
            </label>
            <div className="flex items-center gap-3 pt-1">
              <input
                type="checkbox"
                id="blockOnSecrets"
                checked={policy.severityThresholds.blockOnSecretLeaks}
                onChange={(e) =>
                  setPolicy((prev) => ({
                    ...prev,
                    severityThresholds: {
                      ...prev.severityThresholds,
                      blockOnSecretLeaks: e.target.checked,
                    },
                  }))
                }
                className="rounded border-slate-300 text-slate-900 focus:ring-slate-900 h-4 w-4"
              />
              <label
                htmlFor="blockOnSecrets"
                className="text-xs text-slate-800 font-medium cursor-pointer"
              >
                Immediately BLOCK any PR containing verified live secrets
              </label>
            </div>
            <p className="text-[11px] text-slate-500">
              Credentials matching token signatures (AWS, GitHub, Stripe, OpenAI) immediately fail check runs.
            </p>
          </div>

          {/* Minimum Health Score */}
          <div className="md:col-span-2 space-y-2 pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-900">
                Minimum Repository Health Score to Pass:
              </label>
              <span className="font-mono text-slate-900 font-bold bg-slate-100 border border-slate-200 px-2 py-0.5 rounded text-xs">
                {policy.severityThresholds.minHealthScoreToPass}%
              </span>
            </div>
            <input
              type="range"
              min="50"
              max="95"
              step="5"
              value={policy.severityThresholds.minHealthScoreToPass}
              onChange={(e) =>
                setPolicy((prev) => ({
                  ...prev,
                  severityThresholds: {
                    ...prev.severityThresholds,
                    minHealthScoreToPass: Number(e.target.value),
                  },
                }))
              }
              className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-slate-900"
            />
            <p className="text-[11px] text-slate-500">
              Pull requests resulting in a composite 30-day health score below this threshold receive a degraded verdict.
            </p>
          </div>
        </div>
      </div>

      {/* Save Action Bar */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={() => {
            setPolicy(DEFAULT_ORG_POLICY);
            setStatusMessage({
              type: "success",
              text: "Reset to recommended policy defaults. Click 'Save Policy Changes' to persist.",
            });
          }}
          className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
        >
          Reset to Recommended
        </button>
        <button
          type="button"
          onClick={handleSavePolicy}
          disabled={savingPolicy || loadingPolicy}
          className="px-6 py-2.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg shadow-sm transition-colors disabled:opacity-50 flex items-center gap-2"
        >
          {savingPolicy ? (
            <>
              <span className="animate-spin text-sm">⏳</span> Saving Changes...
            </>
          ) : (
            "Save Policy Changes"
          )}
        </button>
      </div>
    </div>
  );
}
