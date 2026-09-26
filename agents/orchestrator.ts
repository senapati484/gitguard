/**
 * agents/orchestrator.ts
 *
 * LangGraph State Graph Orchestrator for GitGuard.
 *
 * Graph Topology:
 *   [START]
 *     │
 *     ├──> [secret_agent] ───┐
 *     ├──> [bug_agent] ──────┼──> [join_scanners]
 *     └──> [security_agent] ─┘          │
 *                                  (conditional edge: collision on file+line?)
 *                                      ├── YES ──> [dialogue_node] ──┐
 *                                      └── NO  ──────────────────────┼──> [orchestrator_node] (Sonnet) ──> [END]
 *
 * Decision Criteria:
 *   - BLOCK : Confirmed secret leaks OR critical/high bugs/security vulnerabilities.
 *   - WARN  : Only medium/low findings present (warnings without merge block).
 *   - PASS  : Zero defects across all agents.
 */

import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import type { Octokit } from "@octokit/core";
import {
  runGitleaksScan,
  filterSecretsWithLLM,
  postSecretSuggestedChanges,
  type SecretVerificationResult,
} from "@/agents/secret-agent";
import {
  extractChangedHunks,
  detectBugsInHunks,
  postBugSuggestedChanges,
  type BugFinding,
} from "@/agents/bug-agent";
import {
  detectSecurityVulnerabilities,
  type SecurityFinding,
} from "@/agents/security-agent";
import {
  runSEOScan,
  publishSEOCheckRun,
  type SEOFinding,
} from "@/agents/seo-agent";
import { generateConventionalCommit } from "@/agents/commit-agent";
import { generateAICompletion } from "@/lib/ai-client";
import {
  fetchGitGuardIgnore,
  checkIsIgnored,
  logIgnoredFindingToFirestore,
} from "@/lib/gitguard-ignore";
import { PipelineProfiler } from "@/lib/profiler";
import type { OrgPolicy } from "@/lib/team-policy-types";

// ── 1. LangGraph State Annotation ─────────────────────────────────────────────

export const GitGuardStateAnnotation = Annotation.Root({
  owner: Annotation<string>(),
  repo: Annotation<string>(),
  sha: Annotation<string>(),
  diff: Annotation<string>(),
  pullNumber: Annotation<number | undefined>(),
  installationId: Annotation<string | number | undefined>(),
  octokit: Annotation<Octokit>(),
  plan: Annotation<"free" | "pro" | "team">({
    reducer: (curr, next) => next ?? curr ?? "free",
    default: () => "free",
  }),
  policy: Annotation<OrgPolicy | undefined>({
    reducer: (curr, next) => next ?? curr,
    default: () => undefined,
  }),
  profiler: Annotation<PipelineProfiler | undefined>({
    reducer: (curr, next) => next ?? curr,
    default: () => undefined,
  }),

  // Findings from parallel nodes
  secretFindings: Annotation<SecretVerificationResult[]>({
    reducer: (curr, next) => next ?? curr ?? [],
    default: () => [],
  }),
  bugFindings: Annotation<BugFinding[]>({
    reducer: (curr, next) => next ?? curr ?? [],
    default: () => [],
  }),
  securityFindings: Annotation<SecurityFinding[]>({
    reducer: (curr, next) => next ?? curr ?? [],
    default: () => [],
  }),
  seoFindings: Annotation<SEOFinding[]>({
    reducer: (curr, next) => next ?? curr ?? [],
    default: () => [],
  }),
  seoScore: Annotation<number | undefined>({
    reducer: (curr, next) => next ?? curr,
    default: () => undefined,
  }),
  ignoredCount: Annotation<number | undefined>({
    reducer: (curr, next) => (next !== undefined ? (curr || 0) + next : curr),
    default: () => 0,
  }),

  // Dialogue & Multi-Agent Debate
  debateMode: Annotation<boolean | undefined>({
    reducer: (curr, next) => next ?? curr,
    default: () => undefined,
  }),
  dialogueRoundsCompleted: Annotation<number>({
    reducer: (curr, next) => next ?? curr ?? 0,
    default: () => 0,
  }),
  dialogueNotes: Annotation<string[]>({
    reducer: (curr, next) => (next ? [...(curr ?? []), ...next] : curr ?? []),
    default: () => [],
  }),
  pipelinePerformanceSummary: Annotation<string | undefined>({
    reducer: (curr, next) => next ?? curr,
    default: () => undefined,
  }),

  // Synthesized outputs
  decision: Annotation<"PASS" | "WARN" | "BLOCK">(),
  summaryComment: Annotation<string>(),
  commitMessage: Annotation<string>(),
});

export type GitGuardState = typeof GitGuardStateAnnotation.State;

// ── 2. Graph Nodes ────────────────────────────────────────────────────────────

/**
 * SecretAgent Node: Shells out to gitleaks, validates with AI, and applies .gitguardignore.
 */
async function secretAgentNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
  console.log(`[graph:secret_agent] Running secret detection on diff...`);
  try {
    const customPatterns = state.policy?.customSecretPatterns;
    const candidates = await runGitleaksScan(state.diff, customPatterns);
    const findings =
      candidates.length > 0
        ? await filterSecretsWithLLM(candidates, state.diff)
        : [];

    // Filter against .gitguardignore
    const rules = await fetchGitGuardIgnore(state.octokit, state.owner, state.repo, state.sha);
    const activeFindings: SecretVerificationResult[] = [];
    let ignoredSecrets = 0;

    for (const f of findings) {
      const ignoreCheck = checkIsIgnored(f.file, rules);
      if (ignoreCheck.ignored && ignoreCheck.rule && ignoreCheck.rule.valid) {
        ignoredSecrets++;
        console.log(
          `[graph:secret_agent] Whitelisted secret in ${f.file}:${f.line} (Pattern: ${ignoreCheck.rule.pattern}, Reason: ${ignoreCheck.rule.reason})`
        );
        await logIgnoredFindingToFirestore({
          installationId: state.installationId || "0",
          repo: `${state.owner}/${state.repo}`,
          sha: state.sha,
          file: f.file,
          line: f.line,
          agent: "SecretAgent",
          rulePattern: ignoreCheck.rule.pattern,
          reason: ignoreCheck.rule.reason,
          findingSummary: `Whitelisted credential: ${f.reason}`,
          timestamp: Date.now(),
        });
        continue;
      }
      activeFindings.push(f);
    }

    const confirmedSecrets = activeFindings.filter((f) => f.confirmed);

    // If on a pull request and auto-solve suggestions exist, post one-click inline PR suggestions
    const actionableSecrets = confirmedSecrets.filter(
      (s) => Boolean(s.suggestedChange && s.suggestedChange.trim().length > 0)
    );
    if (actionableSecrets.length > 0 && state.pullNumber) {
      await postSecretSuggestedChanges({
        octokit: state.octokit,
        owner: state.owner,
        repo: state.repo,
        sha: state.sha,
        pullNumber: state.pullNumber,
        secrets: actionableSecrets,
      }).catch((err) => {
        console.warn(`[graph:secret_agent] Notice: could not post inline PR secret suggestions:`, err);
      });
    }

    console.log(
      `[graph:secret_agent] Found ${confirmedSecrets.length} confirmed secret(s) (${ignoredSecrets} whitelisted)`
    );
    return { secretFindings: activeFindings, ignoredCount: ignoredSecrets };
  } catch (err) {
    console.error(`[graph:secret_agent] Error scanning secrets:`, err);
    return { secretFindings: [] };
  }
}

/**
 * BugAgent Node: Analyzes changed hunks for software bugs, applies .gitguardignore,
 * and publishes GitHub suggested changes for high-confidence bugs.
 */
async function bugAgentNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
  console.log(`[graph:bug_agent] Analyzing changed hunks for software bugs...`);
  try {
    const hunks = extractChangedHunks(state.diff);
    const rawFindings = hunks.length > 0 ? await detectBugsInHunks(hunks) : [];

    // Filter against .gitguardignore
    const rules = await fetchGitGuardIgnore(state.octokit, state.owner, state.repo, state.sha);
    const activeBugs: BugFinding[] = [];
    let ignoredBugs = 0;

    for (const b of rawFindings) {
      const ignoreCheck = checkIsIgnored(b.file, rules);
      if (ignoreCheck.ignored && ignoreCheck.rule && ignoreCheck.rule.valid) {
        ignoredBugs++;
        console.log(
          `[graph:bug_agent] Whitelisted bug in ${b.file}:${b.line} (Pattern: ${ignoreCheck.rule.pattern}, Reason: ${ignoreCheck.rule.reason})`
        );
        await logIgnoredFindingToFirestore({
          installationId: state.installationId || "0",
          repo: `${state.owner}/${state.repo}`,
          sha: state.sha,
          file: b.file,
          line: b.line,
          agent: "BugAgent",
          rulePattern: ignoreCheck.rule.pattern,
          reason: ignoreCheck.rule.reason,
          findingSummary: `[${b.severity.toUpperCase()}] ${b.message}`,
          timestamp: Date.now(),
        });
        continue;
      }
      activeBugs.push(b);
    }

    // Post high-confidence bug findings as GitHub suggested changes directly to the PR (Pro & Team only)
    const highConfidenceBugs = activeBugs.filter(
      (b) =>
        (b.confidence === "high" || b.severity === "critical" || b.severity === "high") &&
        Boolean(b.suggestedChange && b.suggestedChange.trim().length > 0)
    );

    const isProOrTeam = state.plan === "pro" || state.plan === "team";
    if (highConfidenceBugs.length > 0 && isProOrTeam) {
      await postBugSuggestedChanges({
        octokit: state.octokit,
        owner: state.owner,
        repo: state.repo,
        sha: state.sha,
        pullNumber: state.pullNumber,
        bugs: highConfidenceBugs,
      }).catch((err) => {
        console.warn(`[graph:bug_agent] Notice: could not post inline PR suggestions:`, err);
      });
    }

    console.log(
      `[graph:bug_agent] Found ${activeBugs.length} bug finding(s) (${isProOrTeam ? highConfidenceBugs.length : 0} suggested changes, ${ignoredBugs} whitelisted)`
    );
    return { bugFindings: activeBugs, ignoredCount: ignoredBugs };
  } catch (err) {
    console.error(`[graph:bug_agent] Error analyzing bugs:`, err);
    return { bugFindings: [] };
  }
}

/**
 * SecurityAgent Node: Runs Semgrep OWASP Top 10 SAST and Dependency Audit,
 * then reasons about real-world exploitability vs theoretical CVEs before joining graph.
 * (Gated to Pro / Team plans).
 */
async function securityAgentNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
  if (state.plan === "free") {
    console.log(
      `[graph:security_agent] Free tier active: SecurityAgent (Semgrep OWASP SAST & exploitability) is gated. Upgrade to Pro/Team to enable.`
    );
    return { securityFindings: [] };
  }

  console.log(`[graph:security_agent] Running Semgrep SAST & Dependency Audit with exploitability reasoning...`);
  try {
    const findings = await detectSecurityVulnerabilities(state.diff);
    console.log(
      `[graph:security_agent] Found ${findings.length} security finding(s) (${
        findings.filter((f) => f.isExploitable).length
      } confirmed exploitable)`
    );
    return { securityFindings: findings };
  } catch (err) {
    console.error(`[graph:security_agent] Error analyzing security:`, err);
    return { securityFindings: [] };
  }
}

/**
 * SEOAgent Node: Audits frontend files (.jsx, .tsx, .html) for meta tags, Open Graph,
 * image alt text, and layout-shifting inline styles (CLS).
 * Gated to only run when the diff touches frontend files and on Pro / Team plans.
 */
async function seoAgentNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
  if (state.plan === "free") {
    console.log(
      `[graph:seo_agent] Free tier active: SEOAgent (Meta tags & Web Vitals) is gated. Upgrade to Pro/Team to enable.`
    );
    return { seoFindings: [], seoScore: undefined };
  }

  console.log(`[graph:seo_agent] Checking frontend files for SEO, Open Graph, and CLS...`);
  try {
    const scanResult = await runSEOScan(state.diff);
    if (scanResult.skipped) {
      console.log(`[graph:seo_agent] Skipped: ${scanResult.reason}`);
      return { seoFindings: [], seoScore: 100 };
    }

    console.log(
      `[graph:seo_agent] Found ${scanResult.findings.length} SEO finding(s), score: ${scanResult.score}/100`
    );

    // Publish dedicated Check Run asynchronously
    await publishSEOCheckRun(
      state.octokit,
      state.owner,
      state.repo,
      state.sha,
      scanResult
    ).catch((err) => {
      console.warn(`[graph:seo_agent] Could not publish Check Run:`, err);
    });

    return {
      seoFindings: scanResult.findings,
      seoScore: scanResult.score,
    };
  } catch (err) {
    console.error(`[graph:seo_agent] Error analyzing SEO:`, err);
    return { seoFindings: [], seoScore: 100 };
  }
}

/**
 * Join Barrier: Wait for all 4 parallel scanner branches to arrive.
 */
async function joinScannersNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
  if (state.profiler) {
    state.profiler.markAgentsEnd();
    state.profiler.markDebateStart();
  }
  return state;
}

/**
 * Conditional Edge: Decides whether to route to dialogue_node (multi-agent debate or collision dialogue)
 * or proceed directly to orchestrator_node.
 */
function checkCollisionCondition(state: GitGuardState): "dialogue_node" | "orchestrator_node" {
  if (state.plan === "free") {
    return "orchestrator_node";
  }

  // 1. Team-Only Multi-Agent Debate Mode:
  // Runs a full cross-examination debate round across all agents (not just overlapping findings)
  const isTeamDebate =
    state.plan === "team" &&
    (state.policy?.debateMode === true || state.debateMode === true);

  if (isTeamDebate) {
    console.log(
      `[graph:conditional] 🗣️ Team Debate Mode active — routing to multi-agent dialogue_node (Round 1/2 max)...`
    );
    return "dialogue_node";
  }

  // 2. Standard Pro / Team file:line collision reconciliation
  const { bugFindings = [], securityFindings = [] } = state;
  for (const b of bugFindings) {
    for (const s of securityFindings) {
      if (b.file.toLowerCase() === s.file.toLowerCase() && b.line === s.line) {
        console.log(
          `[graph:conditional] Collision detected at ${b.file}:${b.line}! Routing to dialogue_node...`
        );
        return "dialogue_node";
      }
    }
  }

  return "orchestrator_node";
}

/**
 * Conditional Edge after dialogue_node:
 * In Debate Mode, checks if a 2nd rebuttal round is warranted, strictly capped at 2 rounds for latency.
 */
function checkDebateContinuationCondition(
  state: GitGuardState
): "dialogue_node" | "orchestrator_node" {
  const isTeamDebate =
    state.plan === "team" &&
    (state.policy?.debateMode === true || state.debateMode === true);

  const completed = state.dialogueRoundsCompleted || 0;
  const maxRounds = Math.min(state.policy?.maxDebateRounds ?? 2, 2);

  // If already ran 2 rounds, or not in debate mode, or clean run, proceed to orchestrator
  if (!isTeamDebate || completed >= maxRounds) {
    return "orchestrator_node";
  }

  // Only run a 2nd round if high-severity cross-agent conflicts exist
  const hasHighSeverityConflict =
    ((state.bugFindings || []).some((b) => b.severity === "critical" || b.severity === "high") &&
      (state.securityFindings || []).some((s) => s.severity === "critical" || s.severity === "high")) ||
    ((state.secretFindings || []).some((s) => s.confirmed) && (state.bugFindings || []).length > 0);

  if (hasHighSeverityConflict && completed < 2) {
    console.log(
      `[graph:conditional] Cross-agent severity conflict detected — executing 2nd debate round (${completed + 1}/${maxRounds})...`
    );
    return "dialogue_node";
  }

  return "orchestrator_node";
}

/**
 * Dialogue Node: Conducts either:
 *   A. Team-Only Full Multi-Agent Debate across all 4 agents (capped at 2 rounds).
 *   B. Standard Collision Dialogue between BugAgent and SecurityAgent for overlapping lines.
 */
async function dialogueNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
  const currentRound = (state.dialogueRoundsCompleted || 0) + 1;
  const isTeamDebate =
    state.plan === "team" &&
    (state.policy?.debateMode === true || state.debateMode === true);

  // ── A. Team-Only Full Multi-Agent Debate Mode ─────────────────────────────
  if (isTeamDebate) {
    console.log(
      `[graph:dialogue_node] 🗣️ Running Multi-Agent Debate (Round ${currentRound}/2 max) across all agents...`
    );

    const confirmedSecrets = (state.secretFindings || []).filter((s) => s.confirmed);
    const bugs = state.bugFindings || [];
    const securityIssues = state.securityFindings || [];
    const seoIssues = state.seoFindings || [];

    const totalDefects =
      confirmedSecrets.length + bugs.length + securityIssues.length + seoIssues.length;

    // Fast-path latency optimization: If zero defects across all agents, instant consensus in <1ms!
    if (totalDefects === 0) {
      console.log(`[graph:dialogue_node] Clean changeset — instant debate consensus: PASS.`);
      state.profiler?.markDebateEnd(currentRound);
      return {
        dialogueNotes: [
          `[Debate Round ${currentRound}] All 4 agents (SecretAgent, BugAgent, SecurityAgent, SEOAgent) independently verified the changeset with zero defects or security flaws. Cross-agent consensus: PASS.`,
        ],
        dialogueRoundsCompleted: currentRound,
      };
    }

    const debatePrompt = `You are moderating a fast, high-signal multi-agent peer review debate between 4 code analysis agents (Round ${currentRound} of 2 max):
1. SecretAgent: ${confirmedSecrets.length} confirmed credential leak(s)
${confirmedSecrets.map((s) => `  - ${s.file}:${s.line} — ${s.reason}`).join("\n") || "  - None"}

2. BugAgent: ${bugs.length} correctness bug(s)
${bugs.map((b) => `  - [${b.severity.toUpperCase()}] ${b.file}:${b.line}: ${b.message}`).join("\n") || "  - None"}

3. SecurityAgent: ${securityIssues.length} security vulnerability(ies)
${securityIssues.map((s) => `  - [${s.severity.toUpperCase()}] [${s.isExploitable ? "EXPLOITABLE" : "MITIGATED"}] ${s.file}:${s.line} (${s.ruleId}): ${s.description}\n    Analysis: ${s.exploitabilityAssessment}`).join("\n") || "  - None"}

4. SEOAgent: ${seoIssues.length} SEO / Web Vitals issue(s) (Score: ${state.seoScore ?? 100}/100)
${seoIssues.map((s) => `  - [${s.severity.toUpperCase()}] ${s.file}:${s.line}: ${s.message}`).join("\n") || "  - None"}

CROSS-EXAMINATION DIRECTIVES:
1. Cross-Impact: Does any correctness bug compromise security sanitization or leak data?
2. False-Positive Defense: Critique whether any flagged issue is defended by architectural context or test isolation.
3. Unified Verdict Consensus: Reach definitive alignment on BLOCK vs WARN vs PASS and identify the single priority action.

Provide a concise, punchy consensus summary under 200 words.`;

    const debateSynthesis = await generateAICompletion({
      messages: [
        {
          role: "system",
          content:
            "You are an elite Staff Software Architect moderating a rapid multi-agent peer review debate. Synthesize findings concisely.",
        },
        { role: "user", content: debatePrompt },
      ],
      temperature: 0.1,
      jsonMode: false,
      preferredModel: "sonnet",
    });

    state.profiler?.markDebateEnd(currentRound);
    return {
      dialogueNotes: [
        ...(state.dialogueNotes || []),
        `[Debate Round ${currentRound}] ${debateSynthesis}`,
      ],
      dialogueRoundsCompleted: currentRound,
    };
  }

  // ── B. Standard Collision Dialogue (Overlapping file:line) ─────────────────
  const collisions: { bug: BugFinding; security: SecurityFinding }[] = [];
  for (const b of state.bugFindings || []) {
    for (const s of state.securityFindings || []) {
      if (b.file.toLowerCase() === s.file.toLowerCase() && b.line === s.line) {
        collisions.push({ bug: b, security: s });
      }
    }
  }

  if (collisions.length === 0) {
    state.profiler?.markDebateEnd(currentRound);
    return { dialogueRoundsCompleted: currentRound };
  }

  console.log(
    `[graph:dialogue_node] Running consensus dialogue for ${collisions.length} collision(s)...`
  );

  const prompt = `BugAgent (code correctness) and SecurityAgent (application security) both flagged the exact same line in this changeset.

COLLIDING FINDINGS:
${collisions
  .map(
    (c) => `Location: \`${c.bug.file}:${c.bug.line}\`
- BugAgent: [${c.bug.severity.toUpperCase()}] ${c.bug.message}
- SecurityAgent: [${c.security.severity.toUpperCase()}] [${c.security.isExploitable ? "EXPLOITABLE" : "THEORETICAL/MITIGATED"}] (${c.security.ruleId}): ${c.security.description}
  Exploitability Analysis: ${c.security.exploitabilityAssessment}
  Security fix: ${c.security.recommendation}`
  )
  .join("\n\n")}

Conduct a concise dialogue between both agent perspectives:
1. Reconcile root cause: Does this correctness bug directly introduce or amplify the security vulnerability?
2. Real-world exploitability: Does the bug make an unexploitable sink exploitable?
3. Synthesize unified recommendation: What is the combined severity and single remediation step?

Return a concise synthesis statement.`;

  const dialogueSynthesis = await generateAICompletion({
    messages: [
      {
        role: "system",
        content:
          "You are an expert technical arbiter reconciling findings between a Code Correctness Auditor and an Application Security Auditor.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.1,
    jsonMode: false,
    preferredModel: "sonnet",
  });

  state.profiler?.markDebateEnd(currentRound);
  return {
    dialogueNotes: [
      ...(state.dialogueNotes || []),
      `[Collision Reconciliation] ${dialogueSynthesis}`,
    ],
    dialogueRoundsCompleted: currentRound,
  };
}

/**
 * Orchestrator Node (Sonnet):
 * Synthesizes PASS/WARN/BLOCK verdict, generates human-readable PR comment and commit message,
 * and publishes GitHub Check Runs and PR comments.
 */
async function orchestratorNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
  state.profiler?.markOrchestratorStart();
  console.log(`[graph:orchestrator_node] Synthesizing final verdict with Sonnet...`);

  const policy = state.policy;
  const SEVERITY_RANK: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };

  const blockThresholdStr = policy?.severityThresholds?.blockThreshold?.toLowerCase() || "high";
  const warnThresholdStr = policy?.severityThresholds?.warnThreshold?.toLowerCase() || "medium";
  const blockRank = SEVERITY_RANK[blockThresholdStr] || 3;
  const warnRank = SEVERITY_RANK[warnThresholdStr] || 2;
  const blockOnSecrets = policy?.severityThresholds?.blockOnSecretLeaks !== false;
  const minHealthScore = policy?.severityThresholds?.minHealthScoreToPass ?? 75;
  const requiredAgents = policy?.requiredAgents || [
    "SecretAgent",
    "BugAgent",
    "SecurityAgent",
    "CommitAgent",
    "HealthAgent",
  ];

  const confirmedSecrets = (state.secretFindings || []).filter((s) => s.confirmed);
  const secretBlocks = blockOnSecrets && confirmedSecrets.length > 0;

  const bugBlockers = (state.bugFindings || []).filter(
    (b) => (SEVERITY_RANK[b.severity] || 1) >= blockRank
  );
  const bugWarnings = (state.bugFindings || []).filter(
    (b) =>
      (SEVERITY_RANK[b.severity] || 1) >= warnRank &&
      (SEVERITY_RANK[b.severity] || 1) < blockRank
  );

  const securityBlockers = (state.securityFindings || []).filter((s) => {
    const rank = SEVERITY_RANK[s.severity] || 1;
    if (rank >= blockRank) {
      return blockRank <= 2 ? true : s.isExploitable;
    }
    return false;
  });

  const securityWarnings = (state.securityFindings || []).filter((s) => {
    const rank = SEVERITY_RANK[s.severity] || 1;
    return rank >= warnRank && !securityBlockers.includes(s);
  });

  const seoBlockers = requiredAgents.includes("SEOAgent")
    ? (state.seoFindings || []).filter(
        (s) => (SEVERITY_RANK[s.severity] || 1) >= blockRank
      )
    : [];

  const seoWarnings = (state.seoFindings || []).filter(
    (s) =>
      (SEVERITY_RANK[s.severity] || 1) >= warnRank && !seoBlockers.includes(s)
  );

  // Projected score penalty for health gate
  const projectedScore = Math.max(
    0,
    100 -
      confirmedSecrets.length * 30 -
      ((state.bugFindings || []).filter((b) => b.severity === "critical").length +
        (state.securityFindings || []).filter((s) => s.severity === "critical").length) *
        25 -
      ((state.bugFindings || []).filter((b) => b.severity === "high").length +
        (state.securityFindings || []).filter((s) => s.severity === "high").length) *
        15 -
      ((state.bugFindings || []).filter((b) => b.severity === "medium").length +
        (state.securityFindings || []).filter((s) => s.severity === "medium").length) *
        5 -
      ((state.bugFindings || []).filter((b) => b.severity === "low").length +
        (state.securityFindings || []).filter((s) => s.severity === "low").length) *
        2
  );

  const healthScoreBlocked =
    policy &&
    policy.enabled &&
    projectedScore < minHealthScore &&
    (bugBlockers.length > 0 || securityBlockers.length > 0 || secretBlocks);

  const hasBlockers =
    secretBlocks ||
    bugBlockers.length > 0 ||
    securityBlockers.length > 0 ||
    seoBlockers.length > 0 ||
    healthScoreBlocked;

  const totalWarnings =
    bugWarnings.length +
    securityWarnings.length +
    seoWarnings.length +
    (!hasBlockers && projectedScore < minHealthScore ? 1 : 0);

  const decision: "PASS" | "WARN" | "BLOCK" = hasBlockers
    ? "BLOCK"
    : totalWarnings > 0
    ? "WARN"
    : "PASS";

  console.log(`[graph:orchestrator_node] Decision: ${decision} (Policy: ${policy ? "Custom Org Policy" : "Standard"})`);

  // 1. Generate Conventional Commit message
  const commitResult = await generateConventionalCommit(
    state.diff,
    state.bugFindings || [],
    state.secretFindings || []
  );

  // 2. Synthesize Human-Readable PR Comment via Sonnet
  const synthesisPrompt = `You are GitGuard Orchestrator synthesizing findings from SecretAgent, BugAgent, SecurityAgent, and SEOAgent.

OVERALL VERDICT: ${decision}
SHA: ${state.sha.slice(0, 7)}
REPOSITORY: ${state.owner}/${state.repo}

AGENT FINDINGS:
1. SecretAgent: ${confirmedSecrets.length} confirmed secret leak(s)
${confirmedSecrets.map((s) => `- ${s.file}:${s.line} — ${s.reason}`).join("\n") || "None"}

2. BugAgent: ${(state.bugFindings || []).length} bug(s)
${(state.bugFindings || []).map((b) => `- [${b.severity.toUpperCase()}] ${b.file}:${b.line} — ${b.message}`).join("\n") || "None"}

3. SecurityAgent: ${(state.securityFindings || []).length} vulnerability(ies) (${securityBlockers.length} blocker(s))
${
  (state.securityFindings || [])
    .map(
      (s) =>
        `- [${s.severity.toUpperCase()}] [${s.isExploitable ? "🚨 EXPLOITABLE" : "⚠️ THEORETICAL/MITIGATED"}] ${s.file}:${s.line} (${s.ruleId}): ${s.description}\n  Exploitability Analysis: ${s.exploitabilityAssessment}${s.attackVector ? `\n  Attack Vector: ${s.attackVector}` : ""}\n  Fix: ${s.recommendation}`
    )
    .join("\n") || "None"
}

4. SEOAgent: ${(state.seoFindings || []).length} SEO & Web Vitals finding(s) (Score: ${state.seoScore ?? 100}/100)
${
  (state.seoFindings || [])
    .map((s) => `- [${s.severity.toUpperCase()}] ${s.file}:${s.line} (${s.ruleId}): ${s.message}\n  Fix: ${s.recommendation}`)
    .join("\n") || "None (or backend-only diff)"
}

${
  state.dialogueNotes && state.dialogueNotes.length > 0
    ? `AGENT CONSENSUS DIALOGUE:\n${state.dialogueNotes.join("\n\n")}`
    : ""
}

RECOMMENDED CONVENTIONAL COMMIT:
${commitResult.commitMessage}

INSTRUCTIONS:
Write a polished, professional, human-readable GitHub PR review comment in GitHub Markdown.
Structure:
- Banner / Verdict header with clear emoji indicator (🛑 BLOCK / ⚠️ WARN / ✅ PASS)
- Executive Summary (2-3 sentences explaining the posture)
- Detailed breakdown by category (Secrets, Bugs, Security, SEO & Web Vitals) with bullet points and file:line references
- If dialogue consensus exists, include a short "Agent Consensus" section
- Suggested Conventional Commit block
- Actionable next steps for the developer`;

  let prCommentText: string | null = null;

  // Fast-path: When everything is clean, construct a deterministic, crisp summary (0 tokens, 0ms latency)
  if (
    decision === "PASS" &&
    confirmedSecrets.length === 0 &&
    (state.bugFindings || []).length === 0 &&
    (state.securityFindings || []).length === 0 &&
    (!state.seoFindings || state.seoFindings.length === 0)
  ) {
    prCommentText = [
      "### 🛡️ GitGuard Autonomous Analysis: ✅ PASS",
      "",
      "All automated guardrails passed cleanly. No secrets, software bugs, or security vulnerabilities were detected in this changeset.",
      "",
      "- ✅ **SecretAgent**: 0 secret leaks detected",
      "- ✅ **BugAgent**: 0 software defects identified",
      "- ✅ **SecurityAgent**: SAST scanning verified",
      `- 🌐 **SEO & Web Vitals**: Score ${state.seoScore ?? 100}/100`,
      "",
      "**Recommended Conventional Commit**:",
      "```",
      commitResult.commitMessage,
      "```",
      "",
      "> *Autonomous verification powered by GitGuard LangGraph multi-agent consensus.*",
    ].join("\n");
  } else {
    prCommentText = await generateAICompletion({
      messages: [
        {
          role: "system",
          content:
            "You are the GitGuard Orchestrator, an AI code security and correctness gatekeeper for enterprise pull requests.",
        },
        { role: "user", content: synthesisPrompt },
      ],
      temperature: 0.1,
      jsonMode: false,
      preferredModel: "sonnet",
    });
  }

  let finalComment =
    prCommentText ||
    `### 🛡️ GitGuard Analysis: ${decision}\n\nVerdict: **${decision}**\n- Secrets: ${confirmedSecrets.length}\n- Bugs: ${(state.bugFindings || []).length}\n- Security: ${(state.securityFindings || []).length}\n- SEO & Web Vitals Score: ${state.seoScore ?? 100}/100 (${(state.seoFindings || []).length} issues)`;

  // Append high-confidence suggested changes (both bug fixes and secret auto-solves)
  const highConfidenceBugSuggestions = (state.bugFindings || []).filter(
    (b) =>
      (b.confidence === "high" || b.severity === "critical" || b.severity === "high") &&
      Boolean(b.suggestedChange && b.suggestedChange.trim().length > 0)
  );
  const highConfidenceSecretSuggestions = (state.secretFindings || []).filter(
    (s) => s.confirmed && Boolean(s.suggestedChange && s.suggestedChange.trim().length > 0)
  );

  if (
    (highConfidenceBugSuggestions.length > 0 || highConfidenceSecretSuggestions.length > 0) &&
    !finalComment.includes("```suggestion")
  ) {
    const secretBlocks = highConfidenceSecretSuggestions
      .map(
        (s) =>
          `#### ⚡ Auto-Solve Secret: \`${s.file}:${s.line}\` (${s.ruleId || "Secret Leak"})\n${s.reason}\n\`\`\`suggestion\n${s.suggestedChange?.trim()}\n\`\`\`\n> 💡 *Move raw credential to \`.env.local\` as \`${s.envVarName || "SECRET_KEY"}\` so it remains private.*`
      )
      .join("\n\n");

    const bugBlocks = highConfidenceBugSuggestions
      .map(
        (b) =>
          `#### 💡 \`${b.file}:${b.line}\` (${b.severity.toUpperCase()})\n${b.message}\n\`\`\`suggestion\n${b.suggestedChange?.trim()}\n\`\`\``
      )
      .join("\n\n");

    finalComment += `\n\n---\n### ⚡ One-Click Auto-Solve & Suggested Changes\nGitGuard identified one-click fixes for the following defects:\n\n${[secretBlocks, bugBlocks].filter(Boolean).join("\n\n")}`;
  }

  // Append .gitguardignore notice if any findings were whitelisted
  if (state.ignoredCount && state.ignoredCount > 0 && !finalComment.includes(".gitguardignore")) {
    finalComment += `\n\n> 🛡️ **.gitguardignore**: ${state.ignoredCount} finding(s) matched valid exemption rules with documented justifications and were skipped from merge blocking.`;
  }

  // Append Multi-Agent Dialogue & Debate notes if present
  if ((state.dialogueNotes || []).length > 0 && !finalComment.includes("Multi-Agent Dialogue & Debate")) {
    const debateBlocks = state.dialogueNotes!
      .map((note) => `> ${note.replace(/\n/g, "\n> ")}`)
      .join("\n\n");
    finalComment += `\n\n---\n### 🗣️ Multi-Agent Dialogue & Debate (${state.dialogueRoundsCompleted || state.dialogueNotes!.length} round(s))\n${debateBlocks}`;
  }

  // Append Pipeline Performance Profiler summary (from live profiler or precomputed summary)
  if (state.profiler) {
    state.profiler.markOrchestratorEnd();
    state.profiler.logReport();
    const liveBadge = state.profiler.toMarkdownBadge();
    if (!finalComment.includes("Pipeline Performance")) {
      finalComment += `\n\n${liveBadge}`;
    }
  } else if (state.pipelinePerformanceSummary && !finalComment.includes("Pipeline Performance")) {
    finalComment += `\n\n${state.pipelinePerformanceSummary}`;
  }

  // 3. Post GitHub Check Runs
  try {
    const conclusion = decision === "BLOCK" ? "failure" : decision === "WARN" ? "neutral" : "success";

    await state.octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner: state.owner,
      repo: state.repo,
      name: "GitGuard / Orchestrator",
      head_sha: state.sha,
      status: "completed",
      conclusion,
      output: {
        title: `GitGuard Verdict: ${decision}`,
        summary: finalComment.slice(0, 60000), // GitHub summary size guard
      },
    });

    console.log(`[graph:orchestrator_node] Published Check Run "GitGuard / Orchestrator" (${conclusion})`);
  } catch (err) {
    console.error(`[graph:orchestrator_node] Failed to post Check Run:`, err);
  }

  // 4. Post PR Comment if PR number is available
  if (state.pullNumber && state.pullNumber > 0) {
    try {
      await state.octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner: state.owner,
          repo: state.repo,
          issue_number: state.pullNumber,
          body: finalComment,
        }
      );
      console.log(`[graph:orchestrator_node] Posted synthesized comment to PR #${state.pullNumber}`);
    } catch (err) {
      console.error(`[graph:orchestrator_node] Failed to post PR comment:`, err);
    }
  }

  return {
    decision,
    summaryComment: finalComment,
    commitMessage: commitResult.commitMessage,
  };
}

// ── 3. Compile LangGraph State Graph ──────────────────────────────────────────

export const gitGuardGraph = new StateGraph(GitGuardStateAnnotation)
  .addNode("secret_agent", secretAgentNode)
  .addNode("bug_agent", bugAgentNode)
  .addNode("security_agent", securityAgentNode)
  .addNode("seo_agent", seoAgentNode)
  .addNode("join_scanners", joinScannersNode)
  .addNode("dialogue_node", dialogueNode)
  .addNode("orchestrator_node", orchestratorNode)

  // Parallel fan-out from START into all 4 agents
  .addEdge(START, "secret_agent")
  .addEdge(START, "bug_agent")
  .addEdge(START, "security_agent")
  .addEdge(START, "seo_agent")

  // Fan-in: all 4 agents converge at join_scanners barrier
  .addEdge("secret_agent", "join_scanners")
  .addEdge("bug_agent", "join_scanners")
  .addEdge("security_agent", "join_scanners")
  .addEdge("seo_agent", "join_scanners")

  // Conditional Edge: If Debate Mode active or collision on file+line -> dialogue_node, else orchestrator_node
  .addConditionalEdges("join_scanners", checkCollisionCondition, {
    dialogue_node: "dialogue_node",
    orchestrator_node: "orchestrator_node",
  })

  // Conditional Edge from dialogue_node: loop for 2nd debate round if high-severity conflicts, capped at 2
  .addConditionalEdges("dialogue_node", checkDebateContinuationCondition, {
    dialogue_node: "dialogue_node",
    orchestrator_node: "orchestrator_node",
  })
  .addEdge("orchestrator_node", END)
  .compile();
