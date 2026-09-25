/**
 * lib/profiler.ts
 *
 * High-Resolution Pipeline Latency Profiler for GitGuard.
 * Tracks and logs exact stage durations across the webhook-to-Check-Run lifecycle:
 *  - GitHub App installation token acquisition (cached vs fetched)
 *  - PR / Compare diff retrieval from GitHub API
 *  - Parallel agent execution (SecretAgent, BugAgent, SecurityAgent, SEOAgent)
 *  - Multi-agent debate mode rounds (capped at 2 rounds)
 *  - Orchestrator Sonnet synthesis and GitHub Check-Run creation
 */

import { performance } from "perf_hooks";

export interface PipelineTimings {
  startTime: number;
  tokenStart?: number;
  tokenEnd?: number;
  tokenCached?: boolean;
  diffStart?: number;
  diffEnd?: number;
  quotaStart?: number;
  quotaEnd?: number;
  agentsStart?: number;
  agentsEnd?: number;
  agentDurations?: {
    secretAgentMs?: number;
    bugAgentMs?: number;
    securityAgentMs?: number;
    seoAgentMs?: number;
  };
  debateStart?: number;
  debateEnd?: number;
  debateRounds?: number;
  orchestratorStart?: number;
  orchestratorEnd?: number;
  endTime?: number;
}

export class PipelineProfiler {
  private timings: PipelineTimings;
  private readonly repo: string;
  private readonly sha: string;

  constructor(repo: string, sha: string) {
    this.repo = repo;
    this.sha = sha.slice(0, 7);
    this.timings = {
      startTime: performance.now(),
      agentDurations: {},
    };
  }

  markTokenStart(): void {
    this.timings.tokenStart = performance.now();
  }

  markTokenEnd(cached: boolean = false): void {
    this.timings.tokenEnd = performance.now();
    this.timings.tokenCached = cached;
  }

  markDiffStart(): void {
    this.timings.diffStart = performance.now();
  }

  markDiffEnd(): void {
    this.timings.diffEnd = performance.now();
  }

  markQuotaStart(): void {
    this.timings.quotaStart = performance.now();
  }

  markQuotaEnd(): void {
    this.timings.quotaEnd = performance.now();
  }

  markAgentsStart(): void {
    this.timings.agentsStart = performance.now();
  }

  markAgentsEnd(): void {
    this.timings.agentsEnd = performance.now();
  }

  recordAgentDuration(
    agent: "secret" | "bug" | "security" | "seo",
    durationMs: number
  ): void {
    if (!this.timings.agentDurations) this.timings.agentDurations = {};
    if (agent === "secret") this.timings.agentDurations.secretAgentMs = durationMs;
    if (agent === "bug") this.timings.agentDurations.bugAgentMs = durationMs;
    if (agent === "security") this.timings.agentDurations.securityAgentMs = durationMs;
    if (agent === "seo") this.timings.agentDurations.seoAgentMs = durationMs;
  }

  markDebateStart(): void {
    this.timings.debateStart = performance.now();
  }

  markDebateEnd(rounds: number = 1): void {
    this.timings.debateEnd = performance.now();
    this.timings.debateRounds = rounds;
  }

  markOrchestratorStart(): void {
    this.timings.orchestratorStart = performance.now();
  }

  markOrchestratorEnd(): void {
    this.timings.orchestratorEnd = performance.now();
    this.timings.endTime = performance.now();
  }

  getSummary(): {
    tokenMs: number;
    tokenCached: boolean;
    diffMs: number;
    quotaMs: number;
    agentsMs: number;
    debateMs: number;
    debateRounds: number;
    orchestratorMs: number;
    totalMs: number;
    under5s: boolean;
  } {
    const t = this.timings;
    const now = performance.now();
    const endTime = t.endTime || now;

    const tokenMs = t.tokenStart && t.tokenEnd ? t.tokenEnd - t.tokenStart : 0;
    const diffMs = t.diffStart && t.diffEnd ? t.diffEnd - t.diffStart : 0;
    const quotaMs = t.quotaStart && t.quotaEnd ? t.quotaEnd - t.quotaStart : 0;
    const agentsMs = t.agentsStart && t.agentsEnd ? t.agentsEnd - t.agentsStart : 0;
    const debateMs = t.debateStart && t.debateEnd ? t.debateEnd - t.debateStart : 0;
    const orchestratorMs =
      t.orchestratorStart && t.orchestratorEnd
        ? t.orchestratorEnd - t.orchestratorStart
        : 0;
    const totalMs = endTime - t.startTime;

    return {
      tokenMs: Math.round(tokenMs * 10) / 10,
      tokenCached: Boolean(t.tokenCached),
      diffMs: Math.round(diffMs * 10) / 10,
      quotaMs: Math.round(quotaMs * 10) / 10,
      agentsMs: Math.round(agentsMs * 10) / 10,
      debateMs: Math.round(debateMs * 10) / 10,
      debateRounds: t.debateRounds || 0,
      orchestratorMs: Math.round(orchestratorMs * 10) / 10,
      totalMs: Math.round(totalMs * 10) / 10,
      under5s: totalMs <= 5000,
    };
  }

  logReport(): void {
    const s = this.getSummary();
    const statusEmoji = s.under5s ? "⚡" : "⏱️";
    const cacheTag = s.tokenCached ? "(HIT - ~1h valid)" : "(MISS - fetched)";

    console.log(
      `\n[profiler] ${statusEmoji} Pipeline Run Summary for ${this.repo} @ ${this.sha}:`
    );
    console.log(
      `  • Token Auth:       ${s.tokenMs}ms ${cacheTag}`
    );
    console.log(`  • Diff & Files:     ${s.diffMs}ms`);
    console.log(`  • Quota & Policy:   ${s.quotaMs}ms`);
    console.log(`  • Parallel Agents:  ${s.agentsMs}ms`);
    if (s.debateRounds > 0) {
      console.log(
        `  • Debate Mode:      ${s.debateMs}ms (${s.debateRounds} round${s.debateRounds > 1 ? "s" : ""})`
      );
    }
    console.log(`  • Orchestrator CR:  ${s.orchestratorMs}ms`);
    console.log(
      `  ──────────────────────────────────────────`
    );
    console.log(
      `  🚀 Total Duration:  ${s.totalMs}ms (${(s.totalMs / 1000).toFixed(2)}s) ${s.under5s ? "✅ [PASS < 5s target]" : "⚠️ [OVER 5s]"}\n`
    );
  }

  toMarkdownBadge(): string {
    const s = this.getSummary();
    const sec = (s.totalMs / 1000).toFixed(2);
    const debateTag = s.debateRounds > 0 ? ` | 🗣️ Debate: ${s.debateMs}ms (${s.debateRounds} rnd)` : "";
    return `> ⚡ **Pipeline Performance**: \`${sec}s\` total (Token: \`${s.tokenMs}ms\` ${s.tokenCached ? "cached" : "fetch"} | Diff: \`${s.diffMs}ms\` | Agents: \`${s.agentsMs}ms\`${debateTag} | Check-Run: \`${s.orchestratorMs}ms\`)`;
  }
}
