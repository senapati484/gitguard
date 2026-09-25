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

  // Dialogue notes between BugAgent and SecurityAgent
  dialogueNotes: Annotation<string[]>({
    reducer: (curr, next) => (next ? [...(curr ?? []), ...next] : curr ?? []),
    default: () => [],
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

    console.log(
      `[graph:secret_agent] Found ${activeFindings.filter((f) => f.confirmed).length} confirmed secret(s) (${ignoredSecrets} whitelisted)`
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
  return state;
}

/**
 * Conditional Edge: Check if BugAgent and SecurityAgent flagged the same file + line.
 * (Dialogue arbitration is enabled on Pro / Team plans).
 */
function checkCollisionCondition(state: GitGuardState): "dialogue_node" | "orchestrator_node" {
  if (state.plan === "free") {
    return "orchestrator_node";
  }

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
 * Dialogue Node: Conducts a reconciliation dialogue between BugAgent and SecurityAgent.
 */
async function dialogueNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
  const collisions: { bug: BugFinding; security: SecurityFinding }[] = [];
  for (const b of state.bugFindings || []) {
    for (const s of state.securityFindings || []) {
      if (b.file.toLowerCase() === s.file.toLowerCase() && b.line === s.line) {
        collisions.push({ bug: b, security: s });
      }
    }
  }

  if (collisions.length === 0) return {};

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

  return { dialogueNotes: [dialogueSynthesis] };
}

/**
 * Orchestrator Node (Sonnet):
 * Synthesizes PASS/WARN/BLOCK verdict, generates human-readable PR comment and commit message,
 * and publishes GitHub Check Runs and PR comments.
 */
async function orchestratorNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
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
    state.bugFindings || []
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

  const prCommentText = await generateAICompletion({
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

  let finalComment =
    prCommentText ||
    `### 🛡️ GitGuard Analysis: ${decision}\n\nVerdict: **${decision}**\n- Secrets: ${confirmedSecrets.length}\n- Bugs: ${(state.bugFindings || []).length}\n- Security: ${(state.securityFindings || []).length}\n- SEO & Web Vitals Score: ${state.seoScore ?? 100}/100 (${(state.seoFindings || []).length} issues)`;

  // Append high-confidence suggested changes if not already included in Sonnet output
  const highConfidenceSuggestions = (state.bugFindings || []).filter(
    (b) =>
      (b.confidence === "high" || b.severity === "critical" || b.severity === "high") &&
      Boolean(b.suggestedChange && b.suggestedChange.trim().length > 0)
  );

  if (highConfidenceSuggestions.length > 0 && !finalComment.includes("```suggestion")) {
    const suggestionBlocks = highConfidenceSuggestions
      .map(
        (b) =>
          `#### 💡 \`${b.file}:${b.line}\` (${b.severity.toUpperCase()})\n${b.message}\n\`\`\`suggestion\n${b.suggestedChange?.trim()}\n\`\`\``
      )
      .join("\n\n");

    finalComment += `\n\n---\n### 💡 High-Confidence Suggested Changes\nGitGuard identified one-click fixes for the following defects:\n\n${suggestionBlocks}`;
  }

  // Append .gitguardignore notice if any findings were whitelisted
  if (state.ignoredCount && state.ignoredCount > 0 && !finalComment.includes(".gitguardignore")) {
    finalComment += `\n\n> 🛡️ **.gitguardignore**: ${state.ignoredCount} finding(s) matched valid exemption rules with documented justifications and were skipped from merge blocking.`;
  }

  // Append Org-Wide Policy notice if active
  if (state.policy && state.policy.enabled && !finalComment.includes("Org-Wide Policy Enforced")) {
    finalComment += `\n\n> 🏢 **Org-Wide Policy Enforced (Team Tier)**: Block: \`${state.policy.severityThresholds.blockThreshold}\` | Warn: \`${state.policy.severityThresholds.warnThreshold}\` | Min Health: \`${state.policy.severityThresholds.minHealthScoreToPass}%\` | Custom Secret Rules: \`${state.policy.customSecretPatterns?.length || 0}\``;
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

  // Conditional Edge: If BugAgent and SecurityAgent collide on file+line -> dialogue_node, else orchestrator_node
  .addConditionalEdges("join_scanners", checkCollisionCondition, {
    dialogue_node: "dialogue_node",
    orchestrator_node: "orchestrator_node",
  })

  // Dialogue converges into Orchestrator node
  .addEdge("dialogue_node", "orchestrator_node")
  .addEdge("orchestrator_node", END)
  .compile();
