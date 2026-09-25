"use client";

/**
 * components/dashboard/TeamPolicyForm.tsx
 *
 * Team-Plan Org-Wide Policy Settings & Immutable Audit Log Viewer.
 * Features:
 *   - Org Policy Controls: Required agents, severity thresholds, health score gate.
 *   - Custom Secret Patterns: Create/edit regex patterns compiled into Gitleaks config.
 *   - Interactive Regex Sandbox: Real-time validation of custom secret patterns.
 *   - Manual Verdict Override: Emergency override with mandatory audit reasoning.
 *   - Immutable Audit Log: Real-time queryable ledger of policy changes, ignores, and overrides.
 */

import React, { useState, useEffect, useCallback } from "react";
import {
  type OrgPolicy,
  type CustomSecretPattern,
  type RequiredAgentName,
  type SeverityLevel,
  type AuditLogRecord,
  type AuditLogAction,
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
  { label: string; icon: string; desc: string; defaultTier: string }
> = {
  SecretAgent: {
    label: "SecretAgent",
    icon: "🔑",
    desc: "Detects leaked credentials, API tokens, and private keys with AI false-positive filtering and Gitleaks rules.",
    defaultTier: "All Tiers",
  },
  BugAgent: {
    label: "BugAgent",
    icon: "🐛",
    desc: "AST & AST-aware LLM analysis identifying logic bugs, null dereferences, and off-by-one errors with suggested fixes.",
    defaultTier: "All Tiers",
  },
  SecurityAgent: {
    label: "SecurityAgent",
    icon: "🛡️",
    desc: "Semgrep OWASP Top 10 SAST engine paired with Sonnet exploitability assessment and sink reachability analysis.",
    defaultTier: "Pro / Team",
  },
  CommitAgent: {
    label: "CommitAgent",
    icon: "📝",
    desc: "Enforces Conventional Commits formatting and synthesizes pull request release summaries.",
    defaultTier: "All Tiers",
  },
  SEOAgent: {
    label: "SEOAgent",
    icon: "⚡",
    desc: "Audits React/Next.js and HTML diffs for Open Graph meta tags, image alt accessibility, and layout-shift inline styles.",
    defaultTier: "Pro / Team",
  },
  HealthAgent: {
    label: "HealthAgent",
    icon: "📈",
    desc: "Aggregates 30-day run history into a composite 0-100 rubric score and exposes live cached SVG repository badges.",
    defaultTier: "All Tiers",
  },
};

export function TeamPolicyForm({
  installations,
  defaultInstallationId,
}: TeamPolicyFormProps) {
  const [selectedInstId, setSelectedInstId] = useState<string>(
    String(defaultInstallationId || installations[0]?.installationId || "")
  );

  const [activeTab, setActiveTab] = useState<
    "policy" | "secrets" | "override" | "audit"
  >("policy");

  // Installation state
  const currentInst =
    installations.find((i) => String(i.installationId) === selectedInstId) ||
    installations[0];
  const [isTeamPlan, setIsTeamPlan] = useState<boolean>(
    currentInst?.plan === "team"
  );

  // Policy state
  const [policy, setPolicy] = useState<OrgPolicy>(DEFAULT_ORG_POLICY);
  const [loadingPolicy, setLoadingPolicy] = useState<boolean>(false);
  const [savingPolicy, setSavingPolicy] = useState<boolean>(false);
  const [policyMessage, setPolicyMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Custom regex builder state
  const [newRuleName, setNewRuleName] = useState("");
  const [newRuleRegex, setNewRuleRegex] = useState("");
  const [newRuleDesc, setNewRuleDesc] = useState("");
  const [newRuleGroup, setNewRuleGroup] = useState<number | undefined>(1);
  const [regexTestInput, setRegexTestInput] = useState(
    'const internalKey = "myorg-api-key-99384820194829103948";\nconst dbUrl = "postgresql://user:pass@staging-db.internal:5432/main";'
  );
  const [regexTestMatches, setRegexTestMatches] = useState<
    Array<{ rule: string; match: string; line: number }>
  >([]);

  // Override sandbox state
  const [overrideRepo, setOverrideRepo] = useState("");
  const [overrideSha, setOverrideSha] = useState("");
  const [overridePull, setOverridePull] = useState("");
  const [overridePrevVerdict, setOverridePrevVerdict] = useState<
    "BLOCK" | "WARN" | "PASS"
  >("BLOCK");
  const [overrideNewVerdict, setOverrideNewVerdict] = useState<
    "PASS" | "WARN" | "BLOCK"
  >("PASS");
  const [overrideReason, setOverrideReason] = useState("");
  const [submittingOverride, setSubmittingOverride] = useState(false);
  const [overrideMessage, setOverrideMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // Audit log state
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [auditFilterAction, setAuditFilterAction] = useState<string>("ALL");
  const [auditFilterRepo, setAuditFilterRepo] = useState<string>("");

  // Plan switch sandbox
  const [switchingPlan, setSwitchingPlan] = useState(false);

  // 1. Fetch policy for selected installation
  const fetchPolicy = useCallback(async (instId: string) => {
    if (!instId) return;
    setLoadingPolicy(true);
    setPolicyMessage(null);
    try {
      const res = await fetch(`/api/installations/${instId}/policy`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load policy");
      }
      setIsTeamPlan(Boolean(data.isTeamPlan));
      if (data.policy) {
        setPolicy(data.policy);
      }
    } catch (err: unknown) {
      console.warn("Notice loading policy:", err);
      // fallback to default
      setPolicy(DEFAULT_ORG_POLICY);
    } finally {
      setLoadingPolicy(false);
    }
  }, []);

  // 2. Fetch audit logs for selected installation
  const fetchAuditLogs = useCallback(
    async (instId: string, action?: string, repo?: string) => {
      if (!instId) return;
      setLoadingAudit(true);
      try {
        const query = new URLSearchParams();
        if (action && action !== "ALL") query.set("action", action);
        if (repo && repo.trim()) query.set("repo", repo.trim());
        query.set("limit", "100");

        const res = await fetch(
          `/api/installations/${instId}/audit-logs?${query.toString()}`
        );
        const data = await res.json();
        if (res.ok && Array.isArray(data.logs)) {
          setAuditLogs(data.logs);
        }
      } catch (err) {
        console.error("Failed to load audit logs:", err);
      } finally {
        setLoadingAudit(false);
      }
    },
    []
  );

  useEffect(() => {
    if (selectedInstId) {
      fetchPolicy(selectedInstId);
      fetchAuditLogs(selectedInstId, auditFilterAction, auditFilterRepo);
    }
  }, [selectedInstId, fetchPolicy, fetchAuditLogs, auditFilterAction, auditFilterRepo]);

  // Handle saving policy
  async function handleSavePolicy() {
    setSavingPolicy(true);
    setPolicyMessage(null);
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
      setPolicyMessage({
        type: "success",
        text: "Org-Wide Policy saved! An immutable policy_change event was logged.",
      });
      // Refresh audit logs
      fetchAuditLogs(selectedInstId, auditFilterAction, auditFilterRepo);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setPolicyMessage({ type: "error", text: msg });
    } finally {
      setSavingPolicy(false);
    }
  }

  // Handle switching to Team plan in demo sandbox
  async function handleDemoUpgradeToTeam() {
    setSwitchingPlan(true);
    try {
      const res = await fetch(`/api/installations/${selectedInstId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "team" }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to upgrade plan");
      }
      setIsTeamPlan(true);
      fetchPolicy(selectedInstId);
      setPolicyMessage({
        type: "success",
        text: "Installation activated on Team tier (Demo Mode). Org policy is now active!",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setPolicyMessage({ type: "error", text: msg });
    } finally {
      setSwitchingPlan(false);
    }
  }

  // Handle adding custom regex secret pattern
  function handleAddCustomRule() {
    if (!newRuleName.trim() || !newRuleRegex.trim()) {
      alert("Please provide both a Rule Name and a valid Regex Pattern.");
      return;
    }

    try {
      new RegExp(newRuleRegex.replace(/^\(\?i\)/, ""));
    } catch {
      alert("Invalid regular expression syntax. Please verify regex.");
      return;
    }

    const id = newRuleName
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .slice(0, 32);

    const newPattern: CustomSecretPattern = {
      id: `${id}-${Date.now().toString(36)}`,
      name: newRuleName.trim(),
      regex: newRuleRegex.trim(),
      description: newRuleDesc.trim() || "Custom organization secret rule",
      secretGroup: newRuleGroup,
      enabled: true,
    };

    setPolicy((prev) => ({
      ...prev,
      customSecretPatterns: [...prev.customSecretPatterns, newPattern],
    }));

    setNewRuleName("");
    setNewRuleRegex("");
    setNewRuleDesc("");
    setNewRuleGroup(1);
    setPolicyMessage({
      type: "success",
      text: "Custom rule added! Click 'Save Org Policy' to persist into Gitleaks config.",
    });
  }

  function handleToggleRule(id: string) {
    setPolicy((prev) => ({
      ...prev,
      customSecretPatterns: prev.customSecretPatterns.map((p) =>
        p.id === id ? { ...p, enabled: !p.enabled } : p
      ),
    }));
  }

  function handleDeleteRule(id: string) {
    setPolicy((prev) => ({
      ...prev,
      customSecretPatterns: prev.customSecretPatterns.filter((p) => p.id !== id),
    }));
  }

  // Live Regex Sandbox Tester
  function handleRunRegexTest() {
    const lines = regexTestInput.split("\n");
    const matches: Array<{ rule: string; match: string; line: number }> = [];

    const activeRules = policy.customSecretPatterns.filter(
      (r) => r.enabled && r.regex?.trim()
    );

    activeRules.forEach((rule) => {
      try {
        let cleanRe = rule.regex;
        let flags = "g";
        if (cleanRe.startsWith("(?i)")) {
          cleanRe = cleanRe.slice(4);
          flags += "i";
        }
        const rx = new RegExp(cleanRe, flags);

        lines.forEach((lineText, idx) => {
          let m: RegExpExecArray | null;
          while ((m = rx.exec(lineText)) !== null) {
            matches.push({
              rule: rule.name,
              match: m[rule.secretGroup ?? 1] || m[0],
              line: idx + 1,
            });
            if (!flags.includes("g")) break;
          }
        });
      } catch (err) {
        console.warn("Regex test error:", err);
      }
    });

    setRegexTestMatches(matches);
  }

  // Handle Manual Verdict Override
  async function handleManualOverride(e: React.FormEvent) {
    e.preventDefault();
    if (!overrideReason.trim() || overrideReason.trim().length < 5) {
      setOverrideMessage({
        type: "error",
        text: "Please provide a mandatory justification reason (min 5 characters) for compliance.",
      });
      return;
    }

    setSubmittingOverride(true);
    setOverrideMessage(null);

    try {
      const res = await fetch(`/api/installations/${selectedInstId}/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: overrideRepo.trim() || undefined,
          sha: overrideSha.trim() || undefined,
          pullNumber: overridePull.trim() ? Number(overridePull) : undefined,
          previousVerdict: overridePrevVerdict,
          newVerdict: overrideNewVerdict,
          reason: overrideReason.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to record override");
      }

      setOverrideMessage({
        type: "success",
        text: `Override applied! Recorded to immutable audit log with ID: ${data.auditId}`,
      });
      setOverrideReason("");
      // Refresh audit logs
      fetchAuditLogs(selectedInstId, auditFilterAction, auditFilterRepo);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setOverrideMessage({ type: "error", text: msg });
    } finally {
      setSubmittingOverride(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Top Header & Installation Selector */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Team Org-Wide Policy & Audit
            </h1>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                isTeamPlan
                  ? "bg-purple-500/10 text-purple-400 border border-purple-500/30"
                  : "bg-amber-500/10 text-amber-400 border border-amber-500/30"
              }`}
            >
              {isTeamPlan ? "🏢 Team Tier Active" : "⚠️ Free / Pro Tier"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Enforce unified scanning standards, configure custom Gitleaks secret patterns, and inspect the immutable compliance ledger.
          </p>
        </div>

        {/* Installation Selector */}
        {installations.length > 1 && (
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-muted-foreground whitespace-nowrap">
              Installation:
            </label>
            <select
              value={selectedInstId}
              onChange={(e) => setSelectedInstId(e.target.value)}
              className="bg-card border border-border text-foreground text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {installations.map((inst) => (
                <option key={inst.installationId} value={String(inst.installationId)}>
                  {inst.accountLogin || `Installation #${inst.installationId}`} (
                  {inst.plan.toUpperCase()})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Non-Team Plan Upgrade / Demo Sandbox Banner */}
      {!isTeamPlan && (
        <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="text-2xl">🔒</span>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Team Tier Governance Feature
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Org-wide required agent policies, custom Gitleaks regex rules, and immutable audit logs require the <strong>Team Plan</strong>.
              </p>
            </div>
          </div>
          <button
            onClick={handleDemoUpgradeToTeam}
            disabled={switchingPlan}
            className="shrink-0 px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-lg text-xs font-semibold shadow transition-all disabled:opacity-50"
          >
            {switchingPlan ? "Activating..." : "🚀 Activate Team Plan (Demo Mode)"}
          </button>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex border-b border-border gap-2">
        <button
          onClick={() => setActiveTab("policy")}
          className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === "policy"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <span>⚙️</span> Org Policy & Thresholds
        </button>
        <button
          onClick={() => setActiveTab("secrets")}
          className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === "secrets"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <span>🔑</span> Custom Secret Patterns ({policy.customSecretPatterns.length})
        </button>
        <button
          onClick={() => setActiveTab("override")}
          className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === "override"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <span>⚖️</span> Verdict Override
        </button>
        <button
          onClick={() => setActiveTab("audit")}
          className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${
            activeTab === "audit"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <span>📜</span> Immutable Audit Log ({auditLogs.length})
        </button>
      </div>

      {/* Status Alert */}
      {policyMessage && (
        <div
          className={`p-3.5 rounded-lg text-xs font-medium border ${
            policyMessage.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : "bg-red-500/10 border-red-500/30 text-red-400"
          }`}
        >
          {policyMessage.text}
        </div>
      )}

      {/* TAB 1: Org Policy & Thresholds */}
      {activeTab === "policy" && (
        <div className="space-y-6">
          {/* Policy Activation Card */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-foreground">
                  Org-Wide Policy Enforcement
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  When enabled, all pull requests and commits across this organization must satisfy these agent and severity constraints.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={policy.enabled}
                  onChange={(e) =>
                    setPolicy((prev) => ({ ...prev, enabled: e.target.checked }))
                  }
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
              </label>
            </div>
          </div>

          {/* Multi-Agent Debate Mode Card (Team Enterprise Feature) */}
          <div className="rounded-xl border border-purple-500/30 bg-purple-500/5 p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xl">🗣️</span>
                  <h3 className="text-base font-semibold text-foreground">
                    Multi-Agent Debate Mode
                  </h3>
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/40">
                    Team Plan
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Runs an extra cross-examination dialogue round between all agents (SecretAgent, BugAgent, SecurityAgent, SEOAgent) before the Orchestrator verdict. Evaluates cross-impact, false positives, and shared exploitability.
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
                <div className="w-11 h-6 bg-muted peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-purple-500/20 text-xs">
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="text-emerald-400 font-semibold">⚡ Fast-Path Consensus:</span>
                <span>Instant &lt;1ms agreement on clean diffs</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="text-amber-400 font-semibold">⏱️ Latency Guard:</span>
                <span>Strictly capped at <strong>2 rounds</strong> (&lt;5s target)</span>
              </div>
            </div>
          </div>

          {/* Required Agents Selection */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-foreground">
                Required Agent Pipeline
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Select the agents mandated to run for every pull request. A check will not pass unless all required agents complete successfully.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pt-2">
              {ALL_AGENT_NAMES.map((name) => {
                const meta = AGENT_META[name];
                const isSelected = policy.requiredAgents.includes(name);

                return (
                  <div
                    key={name}
                    onClick={() => {
                      setPolicy((prev) => {
                        const exists = prev.requiredAgents.includes(name);
                        const nextAgents = exists
                          ? prev.requiredAgents.filter((a) => a !== name)
                          : [...prev.requiredAgents, name];
                        return { ...prev, requiredAgents: nextAgents };
                      });
                    }}
                    className={`cursor-pointer rounded-lg border p-4 transition-all ${
                      isSelected
                        ? "border-primary bg-primary/5 shadow-sm"
                        : "border-border bg-card/50 hover:border-border/80 opacity-70"
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xl">{meta.icon}</span>
                        <span className="text-sm font-semibold text-foreground">
                          {meta.label}
                        </span>
                      </div>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        readOnly
                        className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
                      {meta.desc}
                    </p>
                    <span className="inline-block mt-3 text-[10px] font-mono text-muted-foreground/80 px-2 py-0.5 rounded bg-muted">
                      {meta.defaultTier}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Severity & Verdict Thresholds */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-5">
            <div>
              <h3 className="text-base font-semibold text-foreground">
                Severity & Verdict Thresholds
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Fine-tune what degree of defects trigger merge-blocking statuses versus advisory warnings.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
              {/* Block Threshold */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-foreground flex items-center justify-between">
                  <span>Minimum Severity to BLOCK:</span>
                  <span className="text-xs font-mono text-red-400 font-bold">
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
                  className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2.5 focus:ring-1 focus:ring-primary"
                >
                  <option value="CRITICAL">CRITICAL (Only exploitable criticals block)</option>
                  <option value="HIGH">HIGH (High & Critical defects block - Recommended)</option>
                  <option value="MEDIUM">MEDIUM (Strict: Medium, High, & Critical block)</option>
                  <option value="LOW">LOW (Zero Tolerance: All defects block)</option>
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Findings at or above this level trigger a <code>BLOCK</code> verdict and fail the GitHub Check Run.
                </p>
              </div>

              {/* Warn Threshold */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-foreground flex items-center justify-between">
                  <span>Minimum Severity to WARN:</span>
                  <span className="text-xs font-mono text-amber-400 font-bold">
                    {policy.severityThresholds.warnThreshold}
                  </span>
                </label>
                <select
                  value={policy.severityThresholds.warnThreshold}
                  onChange={(e) =>
                    setPolicy((prev) => ({
                      ...prev,
                      severityThresholds: {
                        ...prev.severityThresholds,
                        warnThreshold: e.target.value as SeverityLevel,
                      },
                    }))
                  }
                  className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2.5 focus:ring-1 focus:ring-primary"
                >
                  <option value="MEDIUM">MEDIUM (Warnings for medium defects without blocking)</option>
                  <option value="LOW">LOW (Informational warnings for low & medium defects)</option>
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Findings at this level post advisory comments to GitHub PRs without failing the build.
                </p>
              </div>

              {/* Health Score Threshold */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-foreground">
                    Minimum Repository Health Score to Pass:
                  </label>
                  <span className="text-xs font-mono text-primary font-bold">
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
                  className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                />
                <p className="text-[11px] text-muted-foreground">
                  Pull requests resulting in a composite health score below this threshold receive a degraded verdict.
                </p>
              </div>

              {/* Block on Secret Leaks */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-foreground">
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
                    className="rounded border-border text-primary focus:ring-primary h-4 w-4"
                  />
                  <label htmlFor="blockOnSecrets" className="text-xs text-foreground font-medium cursor-pointer">
                    Immediately BLOCK any PR containing verified live secrets
                  </label>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Guarantees that credentials matching either standard Gitleaks or custom regex rules halt merges immediately.
                </p>
              </div>
            </div>
          </div>

          {/* Save Action */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              onClick={() => setPolicy(DEFAULT_ORG_POLICY)}
              className="px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground border border-border rounded-lg"
            >
              Reset to Recommended
            </button>
            <button
              onClick={handleSavePolicy}
              disabled={savingPolicy || loadingPolicy}
              className="px-5 py-2 text-xs font-semibold text-white bg-primary hover:bg-primary/90 rounded-lg shadow disabled:opacity-50 flex items-center gap-2"
            >
              {savingPolicy ? (
                <>
                  <span className="animate-spin">⏳</span> Saving Policy...
                </>
              ) : (
                "Save Org Policy"
              )}
            </button>
          </div>
        </div>
      )}

      {/* TAB 2: Custom Secret Patterns */}
      {activeTab === "secrets" && (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-foreground">
                Custom Regex Secret Rules (Gitleaks Integration)
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Define proprietary organization secret regex patterns. GitGuard automatically translates these into Gitleaks <code>[[rules]]</code> configuration and performs line-by-line defense-in-depth scanning.
              </p>
            </div>

            {/* Pattern List */}
            <div className="space-y-3 pt-2">
              {policy.customSecretPatterns.map((pattern) => (
                <div
                  key={pattern.id}
                  className={`rounded-lg border p-4 transition-all flex flex-col md:flex-row md:items-center justify-between gap-4 ${
                    pattern.enabled
                      ? "border-border bg-background"
                      : "border-border/50 bg-background/50 opacity-60"
                  }`}
                >
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-foreground">
                        {pattern.name}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground px-2 py-0.5 rounded bg-muted">
                        id: {pattern.id}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {pattern.description}
                    </p>
                    <div className="font-mono text-xs text-primary/90 bg-muted/50 p-2 rounded border border-border/40 overflow-x-auto">
                      <code>{pattern.regex}</code>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      onClick={() => handleToggleRule(pattern.id)}
                      className={`px-3 py-1.5 rounded text-xs font-medium border ${
                        pattern.enabled
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                          : "bg-muted text-muted-foreground border-border"
                      }`}
                    >
                      {pattern.enabled ? "Active" : "Disabled"}
                    </button>
                    <button
                      onClick={() => handleDeleteRule(pattern.id)}
                      className="px-2.5 py-1.5 rounded text-xs font-medium text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/30 transition-colors"
                      title="Delete rule"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}

              {policy.customSecretPatterns.length === 0 && (
                <div className="text-center py-8 text-sm text-muted-foreground border border-dashed border-border rounded-lg">
                  No custom regex secret patterns defined yet.
                </div>
              )}
            </div>
          </div>

          {/* Add New Rule Form */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <h4 className="text-sm font-semibold text-foreground">
              Add New Custom Secret Rule
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Rule Name:
                </label>
                <input
                  type="text"
                  placeholder="e.g., Internal Service JWT Token"
                  value={newRuleName}
                  onChange={(e) => setNewRuleName(e.target.value)}
                  className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2.5 focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Description:
                </label>
                <input
                  type="text"
                  placeholder="e.g., Detects company infrastructure signing keys"
                  value={newRuleDesc}
                  onChange={(e) => setNewRuleDesc(e.target.value)}
                  className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2.5 focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="md:col-span-2 space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Regex Pattern:
                </label>
                <input
                  type="text"
                  placeholder="e.g., (?i)internal[-_]token['&quot;]?\s*[:=]\s*['&quot;]?([a-zA-Z0-9_\-]{32,})"
                  value={newRuleRegex}
                  onChange={(e) => setNewRuleRegex(e.target.value)}
                  className="w-full bg-background border border-border text-foreground text-xs font-mono rounded-lg p-2.5 focus:ring-1 focus:ring-primary"
                />
                <p className="text-[11px] text-muted-foreground">
                  Compatible with PCRE / Go regexp syntax used by Gitleaks. Prefix with <code>(?i)</code> for case insensitivity.
                </p>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={handleAddCustomRule}
                className="px-4 py-2 text-xs font-semibold bg-primary text-white rounded-lg hover:bg-primary/90 shadow"
              >
                + Add Custom Rule
              </button>
            </div>
          </div>

          {/* Interactive Regex Sandbox */}
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-semibold text-foreground">
                  🧪 Interactive Regex Sandbox
                </h4>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Test your active custom rules against sample code or commit diffs in real time.
                </p>
              </div>
              <button
                type="button"
                onClick={handleRunRegexTest}
                className="px-3.5 py-1.5 text-xs font-semibold bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-lg border border-border"
              >
                ▶ Test Regex Matches
              </button>
            </div>

            <textarea
              rows={4}
              value={regexTestInput}
              onChange={(e) => setRegexTestInput(e.target.value)}
              className="w-full bg-background border border-border font-mono text-xs rounded-lg p-3 text-foreground focus:ring-1 focus:ring-primary"
              placeholder="Paste sample code or diff here to test regex matching..."
            />

            {regexTestMatches.length > 0 && (
              <div className="p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs space-y-1.5">
                <span className="font-semibold text-emerald-400">
                  🎯 Found {regexTestMatches.length} match(es):
                </span>
                {regexTestMatches.map((m, idx) => (
                  <div key={idx} className="font-mono text-[11px] text-emerald-300">
                    Line {m.line} [{m.rule}]: <code>{m.match}</code>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Save Action */}
          <div className="flex justify-end pt-2">
            <button
              onClick={handleSavePolicy}
              disabled={savingPolicy}
              className="px-5 py-2 text-xs font-semibold text-white bg-primary hover:bg-primary/90 rounded-lg shadow disabled:opacity-50"
            >
              {savingPolicy ? "Saving Policy..." : "Save Org Policy & Compile TOML"}
            </button>
          </div>
        </div>
      )}

      {/* TAB 3: Verdict Override Sandbox */}
      {activeTab === "override" && (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-foreground">
                Emergency Manual Verdict Override
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Authorized administrators can manually override a failed check run verdict (e.g. for emergency hotfixes or audited false positives). Every override is permanently written to the immutable audit log.
              </p>
            </div>

            {overrideMessage && (
              <div
                className={`p-3.5 rounded-lg text-xs font-medium border ${
                  overrideMessage.type === "success"
                    ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                    : "bg-red-500/10 border-red-500/30 text-red-400"
                }`}
              >
                {overrideMessage.text}
              </div>
            )}

            <form onSubmit={handleManualOverride} className="space-y-4 pt-2">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Repository:
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. owner/repo"
                    value={overrideRepo}
                    onChange={(e) => setOverrideRepo(e.target.value)}
                    className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2.5 focus:ring-1 focus:ring-primary"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Commit SHA:
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. 7c9a1f2b4e..."
                    value={overrideSha}
                    onChange={(e) => setOverrideSha(e.target.value)}
                    className="w-full bg-background border border-border text-foreground text-xs font-mono rounded-lg p-2.5 focus:ring-1 focus:ring-primary"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    PR Number (Optional):
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 42"
                    value={overridePull}
                    onChange={(e) => setOverridePull(e.target.value)}
                    className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2.5 focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Previous Verdict:
                  </label>
                  <select
                    value={overridePrevVerdict}
                    onChange={(e) =>
                      setOverridePrevVerdict(e.target.value as "BLOCK" | "WARN" | "PASS")
                    }
                    className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2.5"
                  >
                    <option value="BLOCK">BLOCK (Check failed)</option>
                    <option value="WARN">WARN (Advisory warnings)</option>
                    <option value="PASS">PASS (Passing)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Target Override Verdict:
                  </label>
                  <select
                    value={overrideNewVerdict}
                    onChange={(e) =>
                      setOverrideNewVerdict(e.target.value as "PASS" | "WARN" | "BLOCK")
                    }
                    className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2.5"
                  >
                    <option value="PASS">PASS (Approve merge)</option>
                    <option value="WARN">WARN (Downgrade to warning)</option>
                    <option value="BLOCK">BLOCK (Force block)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Mandatory Compliance Justification Reason:
                </label>
                <textarea
                  rows={3}
                  required
                  placeholder="Explain why this override is necessary (e.g., False positive confirmed by AppSec team in Jira SEC-892)..."
                  value={overrideReason}
                  onChange={(e) => setOverrideReason(e.target.value)}
                  className="w-full bg-background border border-border text-foreground text-xs rounded-lg p-2.5 focus:ring-1 focus:ring-primary"
                />
                <p className="text-[11px] text-muted-foreground">
                  This justification is permanently sealed into the immutable audit record alongside your user ID and timestamp.
                </p>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={submittingOverride}
                  className="px-5 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-lg shadow disabled:opacity-50"
                >
                  {submittingOverride ? "Recording Override..." : "⚡ Execute Authorized Override"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TAB 4: Immutable Audit Log Viewer */}
      {activeTab === "audit" && (
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
                  <span>🔒</span> Immutable Compliance Audit Trail
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Write-once cryptographically traceable collection capturing every <code>.gitguardignore</code> whitelisting, manual verdict override, and policy modification.
                </p>
              </div>

              <div className="flex items-center gap-2">
                {/* Filter by action */}
                <select
                  value={auditFilterAction}
                  onChange={(e) => setAuditFilterAction(e.target.value)}
                  className="bg-background border border-border text-foreground text-xs rounded-lg px-2.5 py-1.5 focus:ring-1 focus:ring-primary"
                >
                  <option value="ALL">All Actions</option>
                  <option value="policy_change">Policy Changes</option>
                  <option value="ignore_applied">.gitguardignore Whitelists</option>
                  <option value="verdict_override">Verdict Overrides</option>
                </select>

                {/* Filter by repo */}
                <input
                  type="text"
                  placeholder="Filter by repo..."
                  value={auditFilterRepo}
                  onChange={(e) => setAuditFilterRepo(e.target.value)}
                  className="bg-background border border-border text-foreground text-xs rounded-lg px-2.5 py-1.5 focus:ring-1 focus:ring-primary w-32 sm:w-40"
                />

                <button
                  onClick={() =>
                    fetchAuditLogs(selectedInstId, auditFilterAction, auditFilterRepo)
                  }
                  className="px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground bg-background"
                >
                  🔄 Refresh
                </button>
              </div>
            </div>

            {/* Audit Log Entries Table / List */}
            {loadingAudit ? (
              <div className="py-12 text-center text-xs text-muted-foreground">
                <span className="animate-spin inline-block mr-2">⏳</span> Loading immutable audit logs...
              </div>
            ) : auditLogs.length === 0 ? (
              <div className="py-12 text-center text-xs text-muted-foreground border border-dashed border-border rounded-lg">
                No audit log records found for this installation.
              </div>
            ) : (
              <div className="space-y-3 pt-2">
                {auditLogs.map((log) => {
                  const actionColors: Record<AuditLogAction, string> = {
                    policy_change: "bg-purple-500/10 text-purple-400 border-purple-500/30",
                    ignore_applied: "bg-amber-500/10 text-amber-400 border-amber-500/30",
                    verdict_override: "bg-rose-500/10 text-rose-400 border-rose-500/30",
                  };

                  const actorName =
                    log.actor.email || log.actor.displayName || log.actor.login || log.actor.uid || "system";

                  return (
                    <div
                      key={log.id || `${log.timestamp}-${Math.random()}`}
                      className="rounded-lg border border-border bg-background p-4 space-y-2 hover:border-border/80 transition-colors"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase font-bold border ${
                              actionColors[log.action] || "bg-muted text-foreground"
                            }`}
                          >
                            {log.action.replace("_", " ")}
                          </span>
                          <span className="text-xs font-semibold text-foreground">
                            {log.description}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span className="font-mono text-[11px] bg-muted px-2 py-0.5 rounded">
                            {actorName}
                          </span>
                          <span>{new Date(log.timestamp).toLocaleString()}</span>
                        </div>
                      </div>

                      {/* Log Details / Context */}
                      <div className="text-xs text-muted-foreground bg-muted/30 p-2.5 rounded border border-border/50 font-mono text-[11px] overflow-x-auto">
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          {log.repo && (
                            <span>
                              <strong>Repo:</strong> {log.repo}
                            </span>
                          )}
                          {log.sha && (
                            <span>
                              <strong>SHA:</strong> {log.sha.slice(0, 7)}
                            </span>
                          )}
                          {log.pullNumber && (
                            <span>
                              <strong>PR:</strong> #{log.pullNumber}
                            </span>
                          )}
                          <span>
                            <strong>Immutable ID:</strong> {log.id || "sealed"}
                          </span>
                        </div>

                        {log.details && (
                          <div className="mt-2 text-foreground/80 whitespace-pre-wrap">
                            {JSON.stringify(log.details, null, 2)}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
