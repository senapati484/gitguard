/**
 * app/api/badge/[installationId]/[repo]/route.ts
 *
 * GET /api/badge/[installationId]/[repo]
 *
 * Returns a cached, vector-rendered SVG badge representing the 30-day
 * security and code correctness health score for the given repository.
 *
 * Features:
 *   - Pulls 30 days of run history from Firestore
 *   - Evaluates weighted rubric (secrets −30, unresolved criticals −25, etc.)
 *   - Color-coded Shields.io-compatible SVG output
 *   - HTTP caching headers (Cache-Control: public, max-age=300, stale-while-revalidate=600)
 */

import { NextRequest, NextResponse } from "next/server";
import { getRepoHealthReport } from "@/agents/health-agent";

export const dynamic = "force-dynamic";

interface RouteParams {
  params:
    | { installationId: string; repo: string }
    | Promise<{ installationId: string; repo: string }>;
}

export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const resolvedParams = await Promise.resolve(params);
  const { installationId, repo } = resolvedParams;

  if (!installationId || !repo) {
    return new NextResponse("Missing installationId or repo parameter", {
      status: 400,
    });
  }

  // Handle URL decoded repository identifier (supports both 'repo' and 'owner/repo')
  const decodedRepo = decodeURIComponent(repo);

  try {
    const report = await getRepoHealthReport(installationId, decodedRepo);

    // ETag based on score, grade, and timestamp hour
    const hourBucket = Math.floor(Date.now() / (1000 * 60 * 5)); // 5-minute bucket
    const etag = `W/"gg-badge-${installationId}-${report.score}-${report.grade}-${hourBucket}"`;

    // Check if client sent matching If-None-Match
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
          ETag: etag,
        },
      });
    }

    return new NextResponse(report.badgeSvg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
        ETag: etag,
        "X-GitGuard-Score": String(report.score),
        "X-GitGuard-Grade": report.grade,
        "X-GitGuard-Pass-Rate": `${report.stats.passRate}%`,
        "X-GitGuard-Total-Runs": String(report.stats.totalRuns),
      },
    });
  } catch (err) {
    console.error(`[badge-api] Failed to generate badge for ${installationId}/${decodedRepo}:`, err);

    // Return a graceful neutral fallback SVG badge on unexpected error
    const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="138" height="20" role="img" aria-label="GitGuard Health: unavailable">
  <title>GitGuard Health: unavailable</title>
  <clipPath id="r"><rect width="138" height="20" rx="3.5" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="88" height="20" fill="#1e293b"/>
    <rect x="88" width="50" height="20" fill="#64748b"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="11" font-weight="600">
    <text x="44" y="14">GitGuard Health</text>
    <text x="113" y="14">offline</text>
  </g>
</svg>`;

    return new NextResponse(fallbackSvg, {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }
}
