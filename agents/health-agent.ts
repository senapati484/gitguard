/**
 * agents/health-agent.ts
 *
 * Repository Security & Health Agent for GitGuard.
 *
 * Capabilities:
 *   1. Pulls 30-day run and audit history from Cloud Firestore (`adminDb`).
 *   2. Evaluates repository health against the weighted rubric in `lib/health-score.ts`.
 *   3. Emits structured health reports including pass rates, defect breakdowns, and grades.
 *   4. Generates and caches SVG badges for README embeds.
 *   5. Persists worker run records into Firestore.
 */

import { adminDb } from "@/lib/firebase-admin";
import {
  calculateHealthScore,
  generateHealthBadgeSvg,
  type RepoRunRecord,
  type HealthScoreResult,
  type HealthGrade,
} from "@/lib/health-score";
import { generateAICompletion } from "@/lib/ai-client";

export interface RepoHealthReport extends HealthScoreResult {
  installationId: string;
  repo: string;
  calculatedAt: string;
  badgeSvg: string;
  aiInsights?: string;
}

// ── In-Memory Cache (TTL: 5 minutes) ──────────────────────────────────────────

interface CacheEntry {
  report: RepoHealthReport;
  expiresAt: number;
}

const badgeCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCacheKey(installationId: string | number, repo: string): string {
  return `${String(installationId).trim().toLowerCase()}::${repo.trim().toLowerCase()}`;
}

// ── 1. Pull 30-Day Run History from Firestore ─────────────────────────────────

/**
 * Retrieves all review runs for a given installation and repo in the last 30 days.
 */
export async function getRepoRunHistory(
  installationId: string | number,
  repo: string,
  days: number = 30
): Promise<RepoRunRecord[]> {
  const thirtyDaysAgo = Date.now() - days * 24 * 60 * 60 * 1000;
  const normalizedRepo = repo.trim().toLowerCase();
  const installIdStr = String(installationId);
  const installIdNum = Number(installationId);

  console.log(
    `[health-agent] Pulling ${days}-day run history from Firestore for ${normalizedRepo} (installation: ${installationId})...`
  );

  const runs: RepoRunRecord[] = [];

  try {
    // 1. Query top-level "runs" collection
    const runsRef = adminDb.collection("runs");

    // Query by installationId + createdAt window
    const snapshot = await runsRef
      .where("installationId", "in", [installIdStr, !isNaN(installIdNum) ? installIdNum : installIdStr])
      .where("createdAt", ">=", thirtyDaysAgo)
      .orderBy("createdAt", "desc")
      .limit(100)
      .get()
      .catch((err) => {
        // Handle missing composite index gracefully by fetching recent runs
        console.warn(`[health-agent] Composite query notice, falling back to installationId filter:`, err.message);
        return runsRef
          .where("installationId", "in", [installIdStr, !isNaN(installIdNum) ? installIdNum : installIdStr])
          .limit(100)
          .get();
      });

    if (snapshot && !snapshot.empty) {
      for (const doc of snapshot.docs) {
        const data = doc.data() as RepoRunRecord;
        const docRepo = String(data.repo || "").trim().toLowerCase();
        const docRepoName = String(data.repoName || "").trim().toLowerCase();

        // Match repo either by full name (owner/repo) or repo name
        if (
          docRepo === normalizedRepo ||
          docRepoName === normalizedRepo ||
          normalizedRepo.endsWith(`/${docRepoName}`) ||
          docRepo.endsWith(`/${normalizedRepo}`)
        ) {
          const createdAt = typeof data.createdAt === "number" ? data.createdAt : Date.now();
          if (createdAt >= thirtyDaysAgo) {
            runs.push({
              id: doc.id,
              ...data,
              createdAt,
            });
          }
        }
      }
    }

    // 2. Also check subcollection installations/{id}/runs if top-level had no matches
    if (runs.length === 0) {
      const subSnapshot = await adminDb
        .collection("installations")
        .doc(installIdStr)
        .collection("runs")
        .where("createdAt", ">=", thirtyDaysAgo)
        .limit(100)
        .get()
        .catch(() => null);

      if (subSnapshot && !subSnapshot.empty) {
        for (const doc of subSnapshot.docs) {
          const data = doc.data() as RepoRunRecord;
          runs.push({
            id: doc.id,
            ...data,
            createdAt: typeof data.createdAt === "number" ? data.createdAt : Date.now(),
          });
        }
      }
    }

    console.log(`[health-agent] Retrieved ${runs.length} run record(s) from Firestore.`);
  } catch (err) {
    console.error(`[health-agent] Error querying run history from Firestore:`, err);
  }

  return runs;
}

// ── 2. Persist Run to Firestore ───────────────────────────────────────────────

/**
 * Records a completed review run to Firestore for historical auditing and badge score calculation.
 */
export async function recordRunToFirestore(
  runData: Omit<RepoRunRecord, "id" | "createdAt"> & { createdAt?: number }
): Promise<string> {
  try {
    const record: Record<string, unknown> = {
      installationId: String(runData.installationId),
      repo: runData.repo,
      owner: runData.owner ?? "",
      repoName: runData.repoName ?? "",
      sha: runData.sha ?? "",
      event: runData.event ?? "push",
      pullNumber: typeof runData.pullNumber === "number" ? runData.pullNumber : null,
      decision: runData.decision,
      secretCount: runData.secretCount ?? 0,
      criticalCount: runData.criticalCount ?? 0,
      highCount: runData.highCount ?? 0,
      mediumCount: runData.mediumCount ?? 0,
      lowCount: runData.lowCount ?? 0,
      dialogueTriggered: Boolean(runData.dialogueTriggered),
      seoScore: runData.seoScore ?? 100,
      seoDefectCount: runData.seoDefectCount ?? 0,
      createdAt: runData.createdAt || Date.now(),
      commitMessage: runData.commitMessage || "",
      summary: runData.summary || "",
    };

    // Save to top-level "runs"
    const docRef = await adminDb.collection("runs").add(record);
    console.log(`[health-agent] Persisted run ${docRef.id} to Firestore for ${record.repo}`);

    // Also link under installation subcollection
    await adminDb
      .collection("installations")
      .doc(String(record.installationId))
      .collection("runs")
      .doc(docRef.id)
      .set(record, { merge: true })
      .catch(() => null);

    // Update parent installation doc with primaryRepo so dashboard always has the actual repository name
    if (record.repo && record.installationId) {
      await adminDb
        .collection("installations")
        .doc(String(record.installationId))
        .set(
          {
            primaryRepo: record.repo,
            repo: record.repo,
            repoName: record.repoName || String(record.repo).split("/")[1] || record.repo,
            owner: record.owner || String(record.repo).split("/")[0] || "",
            updatedAt: Date.now(),
          },
          { merge: true }
        )
        .catch(() => null);
    }

    // Invalidate badge cache for this repo
    const cacheKey = getCacheKey(
      String(record.installationId ?? ""),
      String(record.repo ?? "")
    );
    badgeCache.delete(cacheKey);

    return docRef.id;
  } catch (err) {
    console.error(`[health-agent] Failed to record run to Firestore:`, err);
    return "";
  }
}

// ── 3. Compute Health Report ──────────────────────────────────────────────────

/**
 * Computes the full 30-day health report for a repository.
 */
export async function getRepoHealthReport(
  installationId: string | number,
  repo: string,
  options: { forceRefresh?: boolean; generateAiInsights?: boolean } = {}
): Promise<RepoHealthReport> {
  const cacheKey = getCacheKey(installationId, repo);
  const now = Date.now();

  if (!options.forceRefresh) {
    const cached = badgeCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.report;
    }
  }

  // Pull 30 days of runs
  const runs = await getRepoRunHistory(installationId, repo, 30);
  const healthResult = calculateHealthScore(runs);

  // Generate SVG badge
  const badgeSvg = generateHealthBadgeSvg({
    score: healthResult.score,
    grade: healthResult.grade,
    color: healthResult.color,
    label: "GitGuard Health",
  });

  const report: RepoHealthReport = {
    ...healthResult,
    installationId: String(installationId),
    repo,
    calculatedAt: new Date().toISOString(),
    badgeSvg,
  };

  // Optional AI Health Insights
  if (options.generateAiInsights && runs.length > 0) {
    try {
      const insightPrompt = `You are GitGuard Health Agent. Summarize the 30-day security and code health posture for ${repo} in 2 concise sentences:
Score: ${report.score}/100 (Grade: ${report.grade}, Status: ${report.status})
Total Runs: ${report.stats.totalRuns}, Pass Rate: ${report.stats.passRate}%
Defects: ${report.stats.secretCount} secrets, ${report.stats.criticalCount} criticals, ${report.stats.highCount} highs, ${report.stats.mediumCount} mediums.
Provide an encouraging and actionable executive summary.`;

      const aiText = await generateAICompletion({
        messages: [
          { role: "system", content: "You are an executive application security auditor." },
          { role: "user", content: insightPrompt },
        ],
        temperature: 0.2,
        jsonMode: false,
      });

      if (aiText) {
        report.aiInsights = aiText;
      }
    } catch {
      // non-fatal
    }
  }

  // Update in-memory cache
  badgeCache.set(cacheKey, {
    report,
    expiresAt: now + CACHE_TTL_MS,
  });

  return report;
}

// ── 4. Cached SVG Badge Provider ──────────────────────────────────────────────

/**
 * Returns a cached SVG badge string for GET /api/badge/[installationId]/[repo].
 */
export async function getCachedBadgeSvg(
  installationId: string | number,
  repo: string
): Promise<string> {
  const report = await getRepoHealthReport(installationId, repo);
  return report.badgeSvg;
}
