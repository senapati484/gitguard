/**
 * lib/audit-log.ts
 *
 * Immutable Audit-Log Engine for GitGuard Enterprise.
 * Records every .gitguardignore bypass, manual verdict override, and org-wide policy change
 * with who (actor) and when (immutable UTC timestamp).
 *
 * Firestore Collection: `audit_logs`
 */

import { adminDb } from "@/lib/firebase-admin";
import type {
  AuditLogAction,
  AuditLogActor,
  AuditLogRecord,
} from "./team-policy-types";

export * from "./team-policy-types";

export interface LogAuditParams {
  action: AuditLogAction;
  actor: AuditLogActor;
  installationId: string | number;
  repo?: string;
  sha?: string;
  pullNumber?: number;
  description: string;
  details: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Appends a record to the immutable audit-log collection in Firestore.
 * Once written, records are marked `immutable: true`.
 */
export async function logAuditEvent(params: LogAuditParams): Promise<string> {
  const ts = params.timestamp || Date.now();
  const isoDate = new Date(ts).toISOString();

  const record: AuditLogRecord = {
    action: params.action,
    actor: params.actor,
    installationId: String(params.installationId),
    repo: params.repo ? params.repo.toLowerCase() : undefined,
    sha: params.sha,
    pullNumber: params.pullNumber,
    description: params.description,
    details: params.details,
    timestamp: ts,
    isoDate,
    immutable: true,
  };

  const cleanRecord: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v !== undefined) {
      if (k === "actor" && typeof v === "object" && v !== null) {
        const cleanActor: Record<string, unknown> = {};
        for (const [ak, av] of Object.entries(v as Record<string, unknown>)) {
          if (av !== undefined) cleanActor[ak] = av;
        }
        cleanRecord.actor = cleanActor;
      } else {
        cleanRecord[k] = v;
      }
    }
  }

  try {
    const docRef = await adminDb.collection("audit_logs").add(cleanRecord);
    console.log(
      `[audit-log] [${record.action}] ${record.description} (actor: ${record.actor.email || record.actor.login || record.actor.uid || "system"})`
    );
    return docRef.id;
  } catch (err) {
    console.error("[audit-log] Failed to write to audit_logs collection:", err);
    return "";
  }
}

export interface GetAuditLogsOptions {
  installationId?: string | number;
  repo?: string;
  action?: AuditLogAction;
  limit?: number;
}

/**
 * Queries immutable audit logs from Firestore with sorting and filtering.
 */
export async function getAuditLogs(
  options: GetAuditLogsOptions = {}
): Promise<AuditLogRecord[]> {
  const { installationId, repo, action, limit = 50 } = options;

  try {
    let query: FirebaseFirestore.Query = adminDb.collection("audit_logs");

    if (installationId) {
      query = query.where("installationId", "in", [
        String(installationId),
        Number(installationId),
      ]);
    }

    if (action) {
      query = query.where("action", "==", action);
    }

    if (repo) {
      query = query.where("repo", "==", repo.toLowerCase().trim());
    }

    let snap: FirebaseFirestore.QuerySnapshot;
    try {
      snap = await query.orderBy("timestamp", "desc").limit(limit).get();
    } catch {
      // Fallback if composite index is building
      snap = await query.limit(limit).get();
    }

    const records: AuditLogRecord[] = snap.docs.map((d) => ({
      id: d.id,
      ...(d.data() as Omit<AuditLogRecord, "id">),
    }));

    // Ensure sorted desc by timestamp in memory if fallback was used
    records.sort((a, b) => b.timestamp - a.timestamp);

    return records;
  } catch (err) {
    console.error("[audit-log] Failed to retrieve audit logs:", err);
    return [];
  }
}
