/**
 * lib/team-policy-types.ts
 *
 * Client-safe TypeScript interfaces and default schemas for Team-plan Org-Wide Policies
 * and the Immutable Audit Log.
 * Zero external dependencies — safe for client components and server code alike.
 */

export type RequiredAgentName =
  | "SecretAgent"
  | "BugAgent"
  | "SecurityAgent"
  | "CommitAgent"
  | "SEOAgent"
  | "HealthAgent";

export type SeverityLevel = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface CustomSecretPattern {
  id: string;
  name: string;
  regex: string;
  description: string;
  secretGroup?: number;
  entropy?: number;
  enabled: boolean;
}

export interface SeverityThresholds {
  blockThreshold: SeverityLevel; // Minimum severity that triggers BLOCK verdict
  warnThreshold: SeverityLevel; // Minimum severity that triggers WARN verdict
  minHealthScoreToPass: number; // 0 to 100
  blockOnSecretLeaks: boolean; // Confirmed secrets always block
}

export interface OrgPolicy {
  enabled: boolean;
  requiredAgents: RequiredAgentName[];
  severityThresholds: SeverityThresholds;
  customSecretPatterns: CustomSecretPattern[];
  updatedAt?: number;
  updatedBy?: {
    uid: string;
    email?: string;
    displayName?: string;
  };
}

export const ALL_AGENT_NAMES: RequiredAgentName[] = [
  "SecretAgent",
  "BugAgent",
  "SecurityAgent",
  "CommitAgent",
  "SEOAgent",
  "HealthAgent",
];

export const DEFAULT_ORG_POLICY: OrgPolicy = {
  enabled: true,
  requiredAgents: ["SecretAgent", "BugAgent", "SecurityAgent", "CommitAgent", "HealthAgent"],
  severityThresholds: {
    blockThreshold: "HIGH",
    warnThreshold: "MEDIUM",
    minHealthScoreToPass: 75,
    blockOnSecretLeaks: true,
  },
  customSecretPatterns: [
    {
      id: "internal-api-key",
      name: "Internal Service JWT/API Token",
      regex: `(?i)(?:myorg|internal)[-_]api[-_]key['"]?\\s*[:=]\\s*['"]?([a-zA-Z0-9_\\-]{24,})`,
      description: "Detects internal infrastructure access keys and internal tokens",
      secretGroup: 1,
      enabled: true,
    },
    {
      id: "staging-db-connection",
      name: "Staging Database Connection String",
      regex: `postgres(?:ql)?://[a-zA-Z0-9_-]+:[a-zA-Z0-9_!@#$%^&*()-+=]+@staging-[a-zA-Z0-9_.-]+:[0-9]+/[a-zA-Z0-9_]+`,
      description: "Prevents committing staging database credentials to application code",
      enabled: true,
    },
  ],
};

export type AuditLogAction =
  | "policy_change"
  | "ignore_applied"
  | "verdict_override";

export interface AuditLogActor {
  uid?: string;
  email?: string;
  displayName?: string;
  login?: string;
  system?: boolean;
  ipAddress?: string;
}

export interface AuditLogRecord {
  id?: string;
  action: AuditLogAction;
  actor: AuditLogActor;
  installationId: string | number;
  repo?: string;
  sha?: string;
  pullNumber?: number;
  description: string;
  timestamp: number;
  isoDate: string;
  details: Record<string, unknown>;
  immutable: true;
}
