"use client";

/**
 * components/dashboard/HealthTrendChart.tsx
 *
 * Interactive Recharts Line / Area chart displaying 30-day security & correctness
 * health score trajectory for a repository.
 */

import React, { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

export interface HealthTrendPoint {
  date: string;
  timestamp: number;
  score: number;
  verdict: "PASS" | "WARN" | "BLOCK";
  sha?: string;
  pullNumber?: number;
  secrets?: number;
  bugs?: number;
  security?: number;
}

export interface HealthTrendChartProps {
  data: HealthTrendPoint[];
  repoName?: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    value: number;
    payload: HealthTrendPoint;
  }>;
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  const point = payload[0].payload;
  const isPass = point.verdict === "PASS";
  const isWarn = point.verdict === "WARN";
  const isBlock = point.verdict === "BLOCK";

  const verdictBg = isPass
    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
    : isWarn
    ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
    : "bg-red-500/10 text-red-400 border-red-500/20";

  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-xl backdrop-blur-md text-xs">
      <div className="flex items-center justify-between gap-4 pb-2 border-b border-border">
        <span className="font-semibold text-foreground">{point.date}</span>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${verdictBg}`}
        >
          {point.verdict}
        </span>
      </div>

      <div className="pt-2 space-y-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Health Score:</span>
          <span className="font-bold text-sm text-foreground">{point.score}/100</span>
        </div>

        {point.pullNumber && (
          <div className="flex items-center justify-between gap-3 text-muted-foreground">
            <span>Pull Request:</span>
            <span className="font-mono text-foreground">#{point.pullNumber}</span>
          </div>
        )}

        {point.sha && (
          <div className="flex items-center justify-between gap-3 text-muted-foreground">
            <span>Commit:</span>
            <span className="font-mono text-foreground">{point.sha.slice(0, 7)}</span>
          </div>
        )}

        <div className="pt-1.5 border-t border-border/50 flex gap-3 text-[11px]">
          <span className="text-red-400">🔒 Secrets: {point.secrets ?? 0}</span>
          <span className="text-amber-400">🐛 Bugs: {point.bugs ?? 0}</span>
          <span className="text-blue-400">🛡️ Sec: {point.security ?? 0}</span>
        </div>
      </div>
    </div>
  );
}

export function HealthTrendChart({ data, repoName }: HealthTrendChartProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div className="h-64 w-full flex items-center justify-center rounded-lg border border-border bg-card/50">
        <p className="text-xs text-muted-foreground animate-pulse">Loading trend chart...</p>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="h-64 w-full flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/30 p-6 text-center">
        <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center mb-3">
          <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        </div>
        <p className="text-sm font-medium text-foreground">No recent review runs found</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          Run your first PR check or push event to generate automated 30-day health score trends.
        </p>
      </div>
    );
  }

  // Calculate current score and delta
  const latestPoint = data[data.length - 1];
  const firstPoint = data[0];
  const scoreDelta = latestPoint.score - firstPoint.score;

  return (
    <div className="w-full space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            30-Day Health Trajectory
          </span>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="text-2xl font-bold tracking-tight text-foreground">
              {latestPoint.score}
              <span className="text-sm font-normal text-muted-foreground">/100</span>
            </span>
            {scoreDelta !== 0 && (
              <span
                className={`text-xs font-semibold ${
                  scoreDelta > 0 ? "text-emerald-500" : "text-red-500"
                }`}
              >
                {scoreDelta > 0 ? `+${scoreDelta}` : scoreDelta} pts
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span>Target (90+)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            <span>Moderate (70)</span>
          </div>
        </div>
      </div>

      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="healthGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />

            <XAxis
              dataKey="date"
              stroke="#64748b"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              dy={8}
            />

            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 90, 100]}
              stroke="#64748b"
              fontSize={11}
              tickLine={false}
              axisLine={false}
            />

            <Tooltip content={<CustomTooltip />} />

            {/* Threshold reference lines */}
            <ReferenceLine y={90} stroke="#10b981" strokeDasharray="4 4" strokeOpacity={0.4} />
            <ReferenceLine y={70} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.3} />

            <Area
              type="monotone"
              dataKey="score"
              stroke="#10b981"
              strokeWidth={2.5}
              fillOpacity={1}
              fill="url(#healthGradient)"
              dot={{ r: 3, fill: "#10b981", strokeWidth: 1, stroke: "#0f172a" }}
              activeDot={{ r: 6, fill: "#34d399", stroke: "#0f172a", strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
