/**
 * agents/commit-agent.ts
 *
 * Commit Agent for GitGuard.
 *
 * Responsibilities:
 *   1. Analyze the git diff and BugAgent findings context.
 *   2. Generate a Conventional Commit message (feat, fix, refactor, etc.) adhering to the specification.
 *   3. If bugs were identified by BugAgent, generate one-click code fix suggestions.
 *   4. Post a PR comment containing the Conventional Commit message and a GitHub
 *      suggested-change block (```suggestion ... ```) that the author can apply in one click.
 *
 * AI Provider:
 *   Uses unified AI client (Groq as primary, Google Gemini as fallback).
 */

import type { Octokit } from "@octokit/core";
import { generateAICompletion } from "@/lib/ai-client";
import type { BugFinding } from "@/agents/bug-agent";
import { extractCompressedHunks } from "@/lib/context-compressor";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CommitMessageResult {
  commitMessage: string;
  type: string;
  scope?: string;
  subject: string;
  body?: string;
  suggestedFix?: {
    file: string;
    line: number;
    replacementCode: string;
    explanation: string;
  };
}

export interface RunCommitAgentOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  sha: string;
  diff: string;
  bugFindings: BugFinding[];
  pullNumber?: number;
}

// ── System Prompt ─────────────────────────────────────────────────────────────

const COMMIT_AGENT_SYSTEM_PROMPT = `You are an expert software engineer and technical writer specializing in git workflow best practices and the Conventional Commits specification (v1.0.0).

TASK:
Analyze the provided git diff and BugAgent context.
1. Generate a high-quality Conventional Commit message for the changeset:
   Format:
   <type>(<scope>): <subject in imperative mood, no period, <= 72 chars>

   <body with bullet points explaining WHAT changed and WHY>

   Allowed types: feat, fix, refactor, perf, test, docs, style, chore, build, ci.
   - If bugs were detected by BugAgent, note them and adjust type to 'fix' if this changeset addresses bugs, or reference the issues in the body.

2. If any BugAgent finding provides an actionable code fix for a specific file and line, provide a concrete one-click replacement code snippet for the GitHub \`\`\`suggestion\`\`\` block.

OUTPUT SCHEMA:
Return ONLY a valid JSON object matching this schema:
{
  "commitMessage": "feat(auth): add null check for user session\\n\\n- Prevent potential null dereference when user session is undefined\\n- Add error handling for async session verification",
  "type": "feat",
  "scope": "auth",
  "subject": "add null check for user session",
  "body": "- Prevent potential null dereference when user session is undefined\\n- Add error handling for async session verification",
  "suggestedFix": {
    "file": "path/to/file.ts",
    "line": 42,
    "replacementCode": "const session = user?.session ?? null;",
    "explanation": "Use optional chaining to guard against null dereference"
  }
}`;

// ── 1. AI Generation ──────────────────────────────────────────────────────────

export async function generateConventionalCommit(
  diff: string,
  bugFindings: BugFinding[]
): Promise<CommitMessageResult> {
  const hunks = extractCompressedHunks(diff);
  const diffContext =
    hunks.length > 0
      ? hunks
          .slice(0, 10)
          .map((h) => `File: ${h.file}\n\`\`\`diff\n${h.diffText.slice(0, 1200)}\n\`\`\``)
          .join("\n\n")
      : diff.slice(0, 4000);

  const userPrompt = `Git Changes Summary:
${diffContext}

BugAgent Findings Context:
${
  bugFindings.length > 0
    ? JSON.stringify(
        bugFindings.map((b) => ({
          file: b.file,
          line: b.line,
          severity: b.severity,
          message: b.message,
        })),
        null,
        2
      )
    : "No bugs found by BugAgent."
}

Generate the Conventional Commit message and suggested-change block in JSON format.`;

  const rawCompletion = await generateAICompletion({
    messages: [
      { role: "system", content: COMMIT_AGENT_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    jsonMode: true,
  });

  if (!rawCompletion) {
    return {
      commitMessage: "chore: update codebase with recent changes",
      type: "chore",
      subject: "update codebase with recent changes",
    };
  }

  try {
    const cleanJson = rawCompletion.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(cleanJson) as CommitMessageResult;
    return parsed;
  } catch (err) {
    console.warn("[commit-agent] Failed to parse AI commit message response:", rawCompletion);
    return {
      commitMessage: "chore: update codebase with recent changes",
      type: "chore",
      subject: "update codebase with recent changes",
    };
  }
}

// ── 2. PR Resolution Helper ───────────────────────────────────────────────────

async function resolvePullNumber(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  explicitPullNumber?: number
): Promise<number | null> {
  if (explicitPullNumber && explicitPullNumber > 0) {
    return explicitPullNumber;
  }

  try {
    // Check if there is an associated PR for this commit SHA
    const prs = await octokit.request(
      "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
      {
        owner,
        repo,
        commit_sha: sha,
      }
    );

    if (prs.data && prs.data.length > 0) {
      return prs.data[0].number;
    }
  } catch (err) {
    console.log(`[commit-agent] Could not resolve PR from commit ${sha}:`, err instanceof Error ? err.message : err);
  }

  return null;
}

// ── 3. Post PR Comments & Suggested-Change Block ──────────────────────────────

/**
 * Runs the Commit Agent:
 *  1. Generates a Conventional Commit message using the diff & bug findings.
 *  2. Resolves the PR number.
 *  3. Posts a PR comment containing a GitHub suggested-change block the author can apply in one click.
 */
export async function runCommitAgent({
  octokit,
  owner,
  repo,
  sha,
  diff,
  bugFindings,
  pullNumber: explicitPullNumber,
}: RunCommitAgentOptions): Promise<{
  success: boolean;
  pullNumber: number | null;
  commitMessage: string;
}> {
  console.log(`[commit-agent] Generating Conventional Commit for ${owner}/${repo} @ ${sha.slice(0, 7)}`);

  const result = await generateConventionalCommit(diff, bugFindings);
  console.log(`[commit-agent] Generated commit: "${result.commitMessage.split("\n")[0]}"`);

  const pullNumber = await resolvePullNumber(
    octokit,
    owner,
    repo,
    sha,
    explicitPullNumber
  );

  if (!pullNumber) {
    console.log(
      `[commit-agent] No open PR associated with commit ${sha.slice(0, 7)}. Skipping PR comment.`
    );
    return {
      success: true,
      pullNumber: null,
      commitMessage: result.commitMessage,
    };
  }

  console.log(`[commit-agent] Posting PR comment to #${pullNumber}...`);

  // Build the PR issue comment body with a GitHub suggested-change block
  let commentBody = `### 🤖 GitGuard / Conventional Commit Suggestion

GitGuard analyzed the diff${bugFindings.length > 0 ? ` and **${bugFindings.length}** bug finding(s)` : ""} to generate a standardized commit message for this PR.

#### Recommended Conventional Commit:
\`\`\`gitcommit
${result.commitMessage}
\`\`\`
`;

  // If there's an actionable code fix suggested from the bug findings, include a suggested-change block:
  if (result.suggestedFix && result.suggestedFix.file && result.suggestedFix.replacementCode) {
    commentBody += `
---

### 💡 Suggested Fix for \`${result.suggestedFix.file}\` (Line ${result.suggestedFix.line})
${result.suggestedFix.explanation ? `> ${result.suggestedFix.explanation}\n` : ""}
\`\`\`suggestion
${result.suggestedFix.replacementCode}
\`\`\`

You can apply the suggestion above directly in GitHub's PR review interface in one click.
`;
  } else {
    // Even without an active bug, provide the suggested commit block
    commentBody += `
---

#### One-Click Commit Message Template
\`\`\`suggestion
${result.commitMessage}
\`\`\`
> **Tip:** You can use this title and description when squashing and merging this pull request.
`;
  }

  // 1. Post top-level PR comment
  try {
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: pullNumber,
        body: commentBody,
      }
    );
    console.log(`[commit-agent] Successfully posted commit suggestion to PR #${pullNumber}`);
  } catch (err) {
    console.error(
      `[commit-agent] Failed to post PR comment to #${pullNumber}:`,
      err instanceof Error ? err.message : err
    );
  }

  // 2. If a specific file and line fix was generated, also try to post an inline PR review comment
  // so the author gets the native interactive "Apply suggestion" button on the diff view!
  if (
    result.suggestedFix &&
    result.suggestedFix.file &&
    result.suggestedFix.line &&
    result.suggestedFix.replacementCode
  ) {
    try {
      const inlineBody = `### 💡 GitGuard One-Click Fix
${result.suggestedFix.explanation ? `${result.suggestedFix.explanation}\n\n` : ""}\`\`\`suggestion
${result.suggestedFix.replacementCode}
\`\`\``;

      await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
        {
          owner,
          repo,
          pull_number: pullNumber,
          commit_id: sha,
          path: result.suggestedFix.file,
          line: result.suggestedFix.line,
          side: "RIGHT",
          body: inlineBody,
        }
      );
      console.log(
        `[commit-agent] Posted inline suggestion to PR #${pullNumber} at ${result.suggestedFix.file}:${result.suggestedFix.line}`
      );
    } catch (inlineErr) {
      // Inline comments can fail if the exact line wasn't part of the diff hunk in this commit
      console.log(
        `[commit-agent] Inline review comment could not be anchored (normal if line outside active hunk):`,
        inlineErr instanceof Error ? inlineErr.message : inlineErr
      );
    }
  }

  return {
    success: true,
    pullNumber,
    commitMessage: result.commitMessage,
  };
}
