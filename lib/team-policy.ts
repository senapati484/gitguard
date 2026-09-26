/**
 * lib/team-policy.ts
 *
 * Server-side management for Team-plan Org-Wide Policies and Gitleaks config generation.
 * Handles reading/updating policies and logging immutable audit events.
 */

import { adminDb } from "@/lib/firebase-admin";
import { logAuditEvent } from "./audit-log";
import {
  DEFAULT_ORG_POLICY,
  type OrgPolicy,
  type CustomSecretPattern,
  type AuditLogActor,
} from "./team-policy-types";

export * from "./team-policy-types";

/**
 * Retrieves the Org-Wide Policy for a given installation.
 * Returns default policy if not customized yet.
 */
export async function getInstallationPolicy(
  installationId: string | number
): Promise<OrgPolicy> {
  const installIdStr = String(installationId);
  const installIdNum = Number(installationId);

  const fetchPolicy = async (): Promise<OrgPolicy> => {
    try {
      const installRef = adminDb.collection("installations");
      let docSnap = await installRef.doc(installIdStr).get();

      if (!docSnap.exists) {
        const q = await installRef
          .where("installationId", "in", [
            installIdStr,
            !isNaN(installIdNum) ? installIdNum : installIdStr,
          ])
          .limit(1)
          .get();

        if (!q.empty) {
          docSnap = q.docs[0];
        }
      }

      if (docSnap.exists) {
        const data = docSnap.data();
        if (data?.policy && typeof data.policy === "object") {
          return {
            ...DEFAULT_ORG_POLICY,
            ...data.policy,
            severityThresholds: {
              ...DEFAULT_ORG_POLICY.severityThresholds,
              ...(data.policy.severityThresholds || {}),
            },
            requiredAgents: Array.isArray(data.policy.requiredAgents)
              ? data.policy.requiredAgents
              : DEFAULT_ORG_POLICY.requiredAgents,
            customSecretPatterns: Array.isArray(data.policy.customSecretPatterns)
              ? data.policy.customSecretPatterns
              : DEFAULT_ORG_POLICY.customSecretPatterns,
          };
        }
      }
    } catch (err) {
      console.warn(
        `[team-policy] Notice: Could not fetch policy for installation ${installationId} (using defaults):`,
        (err as Error)?.message || err
      );
    }
    return DEFAULT_ORG_POLICY;
  };

  // Guard against gRPC connection hangs during webhook processing (2.5s cap)
  const timeoutPromise = new Promise<OrgPolicy>((resolve) =>
    setTimeout(() => resolve(DEFAULT_ORG_POLICY), 2500)
  );

  return Promise.race([fetchPolicy(), timeoutPromise]);
}

/**
 * Updates the Org-Wide Policy on the installation document and writes
 * an immutable audit log entry recording who and when the change was made.
 */
export async function updateInstallationPolicy(
  installationId: string | number,
  newPolicy: Partial<OrgPolicy>,
  actor: AuditLogActor
): Promise<OrgPolicy> {
  const installIdStr = String(installationId);
  const installIdNum = Number(installationId);
  const installRef = adminDb.collection("installations");

  let targetDocId = installIdStr;
  const currentPolicy = await getInstallationPolicy(installationId);

  const docSnap = await installRef.doc(installIdStr).get();
  if (!docSnap.exists) {
    const q = await installRef
      .where("installationId", "in", [
        installIdStr,
        !isNaN(installIdNum) ? installIdNum : installIdStr,
      ])
      .limit(1)
      .get();

    if (!q.empty) {
      targetDocId = q.docs[0].id;
    }
  }

  const mergedPolicy: OrgPolicy = {
    ...currentPolicy,
    ...newPolicy,
    severityThresholds: {
      ...currentPolicy.severityThresholds,
      ...(newPolicy.severityThresholds || {}),
    },
    requiredAgents: newPolicy.requiredAgents || currentPolicy.requiredAgents,
    customSecretPatterns:
      newPolicy.customSecretPatterns || currentPolicy.customSecretPatterns,
    debateMode:
      newPolicy.debateMode !== undefined ? newPolicy.debateMode : currentPolicy.debateMode ?? true,
    maxDebateRounds:
      newPolicy.maxDebateRounds !== undefined
        ? Math.min(newPolicy.maxDebateRounds, 2)
        : currentPolicy.maxDebateRounds ?? 2,
    updatedAt: Date.now(),
    updatedBy: {
      uid: actor.uid || "system",
      email: actor.email,
      displayName: actor.displayName || actor.login,
    },
  };

  // Determine what changed for the audit log
  const changedFields: string[] = [];
  if (JSON.stringify(currentPolicy.requiredAgents) !== JSON.stringify(mergedPolicy.requiredAgents)) {
    changedFields.push(`requiredAgents (${mergedPolicy.requiredAgents.join(", ")})`);
  }
  if (JSON.stringify(currentPolicy.severityThresholds) !== JSON.stringify(mergedPolicy.severityThresholds)) {
    changedFields.push(
      `severityThresholds (block: ${mergedPolicy.severityThresholds.blockThreshold}, warn: ${mergedPolicy.severityThresholds.warnThreshold}, minHealthScore: ${mergedPolicy.severityThresholds.minHealthScoreToPass})`
    );
  }
  if (JSON.stringify(currentPolicy.customSecretPatterns) !== JSON.stringify(mergedPolicy.customSecretPatterns)) {
    changedFields.push(`customSecretPatterns (${mergedPolicy.customSecretPatterns.length} rules)`);
  }
  if (currentPolicy.debateMode !== mergedPolicy.debateMode) {
    changedFields.push(`debateMode: ${mergedPolicy.debateMode}`);
  }
  if (currentPolicy.enabled !== mergedPolicy.enabled) {
    changedFields.push(`policyEnabled: ${mergedPolicy.enabled}`);
  }

  // Update installation doc
  await installRef.doc(targetDocId).set(
    {
      policy: mergedPolicy,
      updatedAt: Date.now(),
    },
    { merge: true }
  );

  // Write immutable audit log record
  await logAuditEvent({
    action: "policy_change",
    actor,
    installationId,
    description: `Updated Org-Wide Policy: ${changedFields.join("; ") || "policy refreshed"}`,
    details: {
      previousPolicy: currentPolicy,
      newPolicy: mergedPolicy,
      changedFields,
    },
  });

  console.log(`[team-policy] Updated policy for installation ${installationId} by ${actor.email || actor.uid}`);
  return mergedPolicy;
}

/**
 * Compiles custom regex secret patterns into a Gitleaks TOML configuration string.
 * This can be written to a temporary file and passed via `--config` to `gitleaks detect`.
 */
export function generateGitleaksToml(patterns: CustomSecretPattern[]): string {
  const enabledPatterns = (patterns || []).filter((p) => p.enabled && p.regex?.trim().length > 0);

  let toml = `# GitGuard Team Policy - Generated Gitleaks Configuration\ntitle = "GitGuard Team Custom Secret Detection Rules"\n\n`;

  for (const pattern of enabledPatterns) {
    const safeId = pattern.id.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    const safeDesc = (pattern.description || pattern.name).replace(/"/g, '\\"');

    toml += `[[rules]]\n`;
    toml += `id = "${safeId}"\n`;
    toml += `description = "${safeDesc}"\n`;
    toml += `regex = '''${pattern.regex}'''\n`;
    if (typeof pattern.secretGroup === "number") {
      toml += `secretGroup = ${pattern.secretGroup}\n`;
    }
    if (typeof pattern.entropy === "number") {
      toml += `entropy = ${pattern.entropy}\n`;
    }
    toml += `\n`;
  }

  return toml;
}
