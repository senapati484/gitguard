/**
 * lib/health-score.ts
 *
 * Repository Security & Correctness Health Score Rubric for GitGuard.
 *
 * Rubric Formulation (0 - 100):
 *   Base Score: 100 points
 *   Deductions:
 *     - Confirmed Leaked Secrets:    −30 points per secret
 *     - Unresolved Critical Defects: −25 points per critical finding
 *     - High Severity Findings:      −15 points per high finding
 *     - Medium Severity Findings:    −5 points per medium finding
 *     - Low Severity Findings:       −2 points per low finding
 *     - Blocked Runs Ratio Penalty:  Up to −15 points based on (blockedRuns / totalRuns)
 *
 * Clamping: Score is clamped to [0, 100].
 */

export type HealthGrade = "A+" | "A" | "B" | "C" | "D" | "F";

export interface RepoRunRecord {
  id?: string;
  installationId: string | number;
  repo: string;
  owner?: string;
  repoName?: string;
  sha?: string;
  event?: string;
  pullNumber?: number;
  decision: "PASS" | "WARN" | "BLOCK";
  secretCount?: number;
  criticalCount?: number;
  highCount?: number;
  mediumCount?: number;
  lowCount?: number;
  dialogueTriggered?: boolean;
  createdAt: number; // Unix timestamp ms
}

export interface HealthRubricWeights {
  secretPenalty: number;
  criticalPenalty: number;
  highPenalty: number;
  mediumPenalty: number;
  lowPenalty: number;
  maxBlockedRatioPenalty: number;
}

export const DEFAULT_RUBRIC_WEIGHTS: HealthRubricWeights = {
  secretPenalty: 30,
  criticalPenalty: 25,
  highPenalty: 15,
  mediumPenalty: 5,
  lowPenalty: 2,
  maxBlockedRatioPenalty: 15,
};

export interface HealthScoreResult {
  score: number;
  grade: HealthGrade;
  status: string;
  color: string;
  stats: {
    totalRuns: number;
    passedRuns: number;
    warnedRuns: number;
    blockedRuns: number;
    secretCount: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    passRate: number; // 0 - 100 %
  };
  penalties: {
    secrets: number;
    criticals: number;
    highs: number;
    mediums: number;
    lows: number;
    blockedRatio: number;
    totalDeductions: number;
  };
}

/**
 * Computes the 0-100 health score from an array of run records within a time window.
 */
export function calculateHealthScore(
  runs: RepoRunRecord[],
  weights: HealthRubricWeights = DEFAULT_RUBRIC_WEIGHTS
): HealthScoreResult {
  const totalRuns = runs.length;

  if (totalRuns === 0) {
    return {
      score: 100,
      grade: "A+",
      status: "No Issues Detected (No Recent Runs)",
      color: "#10b981",
      stats: {
        totalRuns: 0,
        passedRuns: 0,
        warnedRuns: 0,
        blockedRuns: 0,
        secretCount: 0,
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
        passRate: 100,
      },
      penalties: {
        secrets: 0,
        criticals: 0,
        highs: 0,
        mediums: 0,
        lows: 0,
        blockedRatio: 0,
        totalDeductions: 0,
      },
    };
  }

  let passedRuns = 0;
  let warnedRuns = 0;
  let blockedRuns = 0;
  let secretCount = 0;
  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  for (const r of runs) {
    if (r.decision === "PASS") passedRuns++;
    else if (r.decision === "WARN") warnedRuns++;
    else if (r.decision === "BLOCK") blockedRuns++;

    secretCount += r.secretCount || 0;
    criticalCount += r.criticalCount || 0;
    highCount += r.highCount || 0;
    mediumCount += r.mediumCount || 0;
    lowCount += r.lowCount || 0;
  }

  const passRate = totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : 100;

  // Calculate deductions
  const secretsDeduction = secretCount * weights.secretPenalty;
  const criticalsDeduction = criticalCount * weights.criticalPenalty;
  const highsDeduction = highCount * weights.highPenalty;
  const mediumsDeduction = mediumCount * weights.mediumPenalty;
  const lowsDeduction = lowCount * weights.lowPenalty;

  const blockedRatio = totalRuns > 0 ? blockedRuns / totalRuns : 0;
  const blockedRatioDeduction = Math.round(blockedRatio * weights.maxBlockedRatioPenalty);

  const totalDeductions =
    secretsDeduction +
    criticalsDeduction +
    highsDeduction +
    mediumsDeduction +
    lowsDeduction +
    blockedRatioDeduction;

  const rawScore = 100 - totalDeductions;
  const score = Math.max(0, Math.min(100, rawScore));

  // Determine grade and color
  let grade: HealthGrade;
  let status: string;
  let color: string;

  if (score >= 95) {
    grade = "A+";
    status = "Pristine";
    color = "#10b981"; // Emerald
  } else if (score >= 90) {
    grade = "A";
    status = "Secure";
    color = "#22c55e"; // Green
  } else if (score >= 80) {
    grade = "B";
    status = "Good";
    color = "#3b82f6"; // Blue
  } else if (score >= 70) {
    grade = "C";
    status = "Moderate Risk";
    color = "#f59e0b"; // Amber
  } else if (score >= 60) {
    grade = "D";
    status = "Elevated Risk";
    color = "#f97316"; // Orange
  } else {
    grade = "F";
    status = "Critical Risk";
    color = "#ef4444"; // Red
  }

  return {
    score,
    grade,
    status,
    color,
    stats: {
      totalRuns,
      passedRuns,
      warnedRuns,
      blockedRuns,
      secretCount,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      passRate,
    },
    penalties: {
      secrets: secretsDeduction,
      criticals: criticalsDeduction,
      highs: highsDeduction,
      mediums: mediumsDeduction,
      lows: lowsDeduction,
      blockedRatio: blockedRatioDeduction,
      totalDeductions,
    },
  };
}

// ── SVG Badge Generator ───────────────────────────────────────────────────────

export interface SvgBadgeOptions {
  score: number;
  grade: HealthGrade;
  color: string;
  label?: string;
}

/**
 * Generates an accessible, crisp, vector-rendered SVG badge in Shields.io style.
 */
export function generateHealthBadgeSvg({
  score,
  grade,
  color,
  label = "GitGuard Health",
}: SvgBadgeOptions): string {
  const valueText = `${score}/100 ${grade}`;

  // Approximate character width calculations for crisp alignment
  const labelWidth = Math.round(label.length * 6.8 + 18);
  const valueWidth = Math.round(valueText.length * 7.5 + 18);
  const totalWidth = labelWidth + valueWidth;
  const height = 20;

  const labelX = Math.round(labelWidth / 2);
  const valueX = Math.round(labelWidth + valueWidth / 2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" role="img" aria-label="${label}: ${valueText}">
  <title>${label}: ${valueText}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".15"/>
    <stop offset="1" stop-opacity=".15"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="${height}" rx="3.5" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="${height}" fill="#1e293b"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="${height}" fill="${color}"/>
    <rect width="${totalWidth}" height="${height}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" text-rendering="geometricPrecision" font-size="11" font-weight="600">
    <text aria-hidden="true" x="${labelX}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelX}" y="14">${label}</text>
    <text aria-hidden="true" x="${valueX}" y="15" fill="#010101" fill-opacity=".3">${valueText}</text>
    <text x="${valueX}" y="14">${valueText}</text>
  </g>
</svg>`;
}
