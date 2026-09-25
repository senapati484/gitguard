/**
 * types/index.ts
 *
 * Shared TypeScript types and interfaces for GitGuard.
 */

// ─── GitHub App ───────────────────────────────────────────────────────────────

/** GitHub webhook event headers */
export interface GitHubWebhookHeaders {
  "x-github-event": string;
  "x-github-delivery": string;
  "x-hub-signature-256": string;
}

/** Minimal representation of a GitHub repository */
export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
}

/** GitHub App installation metadata */
export interface GitHubInstallation {
  id: number;
  account: {
    login: string;
    type: "User" | "Organization";
  };
  repositories?: GitHubRepo[];
  created_at: string;
}

// ─── Security Checks ─────────────────────────────────────────────────────────

export type CheckSeverity = "critical" | "high" | "medium" | "low" | "info";
export type CheckStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface SecurityCheck {
  id: string;
  name: string;
  description: string;
  severity: CheckSeverity;
  status: CheckStatus;
  repoFullName: string;
  commitSha: string;
  details?: string;
  createdAt: string;
  completedAt?: string;
}

// ─── User / Auth ──────────────────────────────────────────────────────────────

export interface AppUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  githubLogin?: string;
  installationId?: number;
}
