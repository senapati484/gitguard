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
  type BugFinding,
} from "@/agents/bug-agent";
import {
  detectSecurityVulnerabilities,
  type SecurityFinding,
} from "@/agents/security-agent";
import { generateConventionalCommit } from "@/agents/commit-agent";
import { generateAICompletion } from "@/lib/ai-client";

// ── 1. LangGraph State Annotation ─────────────────────────────────────────────

export const GitGuardStateAnnotation = Annotation.Root({
  owner: Annotation<string>(),
  repo: Annotation<string>(),
  sha: Annotation<string>(),
  diff: Annotation<string>(),
  pullNumber: Annotation<number | undefined>(),
  octokit: Annotation<Octokit>(),

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
 * SecretAgent Node: Shells out to gitleaks and uses AI to filter false positives.
 */
async function secretAgentNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
  console.log(`[graph:secret_agent] Running secret detection on diff...`);
  try {
    const candidates = await runGitleaksScan(state.diff);
    const findings =
      candidates.length > 0
        ? await filterSecretsWithLLM(candidates, state.diff)
        : [];
    console.log(`[graph:secret_agent] Found ${findings.filter((f) => f.confirmed).length} confirmed secret(s)`);
    return { secretFindings: findings };
  } catch (err) {
    console.error(`[graph:secret_agent] Error scanning secrets:`, err);
    return { secretFindings: [] };
  }
}

/**
 * BugAgent Node: Analyzes changed hunks for null derefs, unhandled promises, race conditions, off-by-ones.
 */
async function bugAgentNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
  console.log(`[graph:bug_agent] Analyzing changed hunks for software bugs...`);
  try {
    const hunks = extractChangedHunks(state.diff);
    const findings = hunks.length > 0 ? await detectBugsInHunks(hunks) : [];
    console.log(`[graph:bug_agent] Found ${findings.length} bug finding(s)`);
    return { bugFindings: findings };
  } catch (err) {
    console.error(`[graph:bug_agent] Error analyzing bugs:`, err);
    return { bugFindings: [] };
  }
}

/**
 * SecurityAgent Node: Runs Semgrep OWASP Top 10 SAST and Dependency Audit,
 * then reasons about real-world exploitability vs theoretical CVEs before joining graph.
 */
async function securityAgentNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
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
 * Join Barrier: Wait for all 3 parallel scanner branches to arrive.
 */
async function joinScannersNode(state: GitGuardState): Promise<Partial<GitGuardState>> {
  return state;
}

/**
 * Conditional Edge: Check if BugAgent and SecurityAgent flagged the same file + line.
 */
function checkCollisionCondition(state: GitGuardState): "dialogue_node" | "orchestrator_node" {
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

  const confirmedSecrets = (state.secretFindings || []).filter((s) => s.confirmed);
  const criticalHighBugs = (state.bugFindings || []).filter(
    (b) => b.severity === "critical" || b.severity === "high"
  );
  // Real-world exploitability gate: Only confirmed exploitable critical/high issues block merge
  const exploitableSecurityBlockers = (state.securityFindings || []).filter(
    (s) => s.isExploitable && (s.severity === "critical" || s.severity === "high")
  );

  const hasBlockers =
    confirmedSecrets.length > 0 ||
    criticalHighBugs.length > 0 ||
    exploitableSecurityBlockers.length > 0;

  const totalWarnings =
    (state.bugFindings || []).filter((b) => b.severity === "medium" || b.severity === "low").length +
    (state.securityFindings || []).filter(
      (s) => !s.isExploitable || s.severity === "medium" || s.severity === "low"
    ).length;

  const decision: "PASS" | "WARN" | "BLOCK" = hasBlockers
    ? "BLOCK"
    : totalWarnings > 0
    ? "WARN"
    : "PASS";

  console.log(`[graph:orchestrator_node] Decision: ${decision}`);

  // 1. Generate Conventional Commit message
  const commitResult = await generateConventionalCommit(
    state.diff,
    state.bugFindings || []
  );

  // 2. Synthesize Human-Readable PR Comment via Sonnet
  const synthesisPrompt = `You are GitGuard Orchestrator synthesizing findings from SecretAgent, BugAgent, and SecurityAgent.

OVERALL VERDICT: ${decision}
SHA: ${state.sha.slice(0, 7)}
REPOSITORY: ${state.owner}/${state.repo}

AGENT FINDINGS:
1. SecretAgent: ${confirmedSecrets.length} confirmed secret leak(s)
${confirmedSecrets.map((s) => `- ${s.file}:${s.line} — ${s.reason}`).join("\n") || "None"}

2. BugAgent: ${(state.bugFindings || []).length} bug(s)
${(state.bugFindings || []).map((b) => `- [${b.severity.toUpperCase()}] ${b.file}:${b.line} — ${b.message}`).join("\n") || "None"}

3. SecurityAgent: ${(state.securityFindings || []).length} vulnerability(ies) (${exploitableSecurityBlockers.length} confirmed exploitable blocker(s))
${
  (state.securityFindings || [])
    .map(
      (s) =>
        `- [${s.severity.toUpperCase()}] [${s.isExploitable ? "🚨 EXPLOITABLE" : "⚠️ THEORETICAL/MITIGATED"}] ${s.file}:${s.line} (${s.ruleId}): ${s.description}\n  Exploitability Analysis: ${s.exploitabilityAssessment}${s.attackVector ? `\n  Attack Vector: ${s.attackVector}` : ""}\n  Fix: ${s.recommendation}`
    )
    .join("\n") || "None"
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
- Detailed breakdown by category (Secrets, Bugs, Security) with bullet points and file:line references
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

  const finalComment =
    prCommentText ||
    `### 🛡️ GitGuard Analysis: ${decision}\n\nVerdict: **${decision}**\n- Secrets: ${confirmedSecrets.length}\n- Bugs: ${(state.bugFindings || []).length}\n- Security: ${(state.securityFindings || []).length}`;

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
  .addNode("join_scanners", joinScannersNode)
  .addNode("dialogue_node", dialogueNode)
  .addNode("orchestrator_node", orchestratorNode)

  // Parallel fan-out from START into all 3 agents
  .addEdge(START, "secret_agent")
  .addEdge(START, "bug_agent")
  .addEdge(START, "security_agent")

  // Fan-in: all 3 agents converge at join_scanners barrier
  .addEdge("secret_agent", "join_scanners")
  .addEdge("bug_agent", "join_scanners")
  .addEdge("security_agent", "join_scanners")

  // Conditional Edge: If BugAgent and SecurityAgent collide on file+line -> dialogue_node, else orchestrator_node
  .addConditionalEdges("join_scanners", checkCollisionCondition, {
    dialogue_node: "dialogue_node",
    orchestrator_node: "orchestrator_node",
  })

  // Dialogue converges into Orchestrator node
  .addEdge("dialogue_node", "orchestrator_node")
  .addEdge("orchestrator_node", END)
  .compile();
