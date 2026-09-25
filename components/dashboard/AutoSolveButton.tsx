"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface AutoSolveButtonProps {
  installationId: string | number;
  runId?: string;
  sha?: string;
  repo?: string;
  initialVerdict?: string;
  secretCount?: number;
  autoSolved?: boolean;
  size?: "sm" | "md";
}

export function AutoSolveButton({
  installationId,
  runId,
  sha,
  repo,
  initialVerdict = "BLOCK",
  secretCount = 0,
  autoSolved = false,
  size = "sm",
}: AutoSolveButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [solved, setSolved] = useState(autoSolved || false);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [remediationInfo, setRemediationInfo] = useState<{
    newScore?: number;
    newGrade?: string;
    message?: string;
  } | null>(null);

  const handleAutoSolve = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/installations/${installationId}/auto-solve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, sha, repo }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to auto-solve run");
      }

      setSolved(true);
      setRemediationInfo({
        newScore: data.newScore,
        newGrade: data.newGrade,
        message: data.message,
      });
      setShowModal(true);

      // Refresh server-side state in Next.js
      router.refresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Auto-solve failed";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (solved) {
    return (
      <div className="inline-flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
          <svg className="w-3 h-3 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
          Auto-Solved
        </span>
        <button
          onClick={() => setShowModal(true)}
          className="text-[11px] text-slate-500 hover:text-slate-800 underline font-medium"
        >
          Details
        </button>

        {showModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 backdrop-blur-xs p-4">
            <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95 duration-150">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-emerald-100 flex items-center justify-center text-emerald-600 shrink-0">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">Run Successfully Auto-Solved</h3>
                  <p className="text-xs text-slate-500">Security incident resolved &amp; health score updated</p>
                </div>
              </div>

              <div className="mt-4 space-y-3 bg-slate-50 rounded-xl p-4 border border-slate-200/80 text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-slate-600 font-medium">Repository Health:</span>
                  <span className="font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                    {remediationInfo?.newScore ?? 100}/100 (Grade {remediationInfo?.newGrade ?? "A+"})
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-600 font-medium">Verdict State:</span>
                  <span className="font-bold text-emerald-700">PASS (Remediated)</span>
                </div>
                <div className="pt-2 border-t border-slate-200 text-slate-600 space-y-1">
                  <p className="font-semibold text-slate-800">🛡️ Local Push Protection Active:</p>
                  <p>GitGuard pre-push hook ensures all future credentials committed by mistake are quarantined into <code className="bg-slate-200/70 px-1 py-0.5 rounded font-mono text-slate-800">.env.local</code> and sanitized before reaching GitHub.</p>
                </div>
              </div>

              <div className="mt-5 flex justify-end">
                <button
                  onClick={() => setShowModal(false)}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition"
                >
                  Close &amp; Continue
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      <button
        onClick={handleAutoSolve}
        disabled={loading}
        title="Automatically sanitize and unblock this run"
        className={`inline-flex items-center gap-1.5 rounded-lg font-bold shadow-xs transition-all ${
          size === "sm"
            ? "px-2.5 py-1 text-[11px]"
            : "px-3.5 py-1.5 text-xs"
        } bg-linear-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white border border-amber-600 active:scale-95 disabled:opacity-50`}
      >
        {loading ? (
          <>
            <svg className="animate-spin h-3 w-3 text-white" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            <span>Solving...</span>
          </>
        ) : (
          <>
            <span>⚡</span>
            <span>Auto-Solve</span>
          </>
        )}
      </button>

      {error && (
        <span className="text-[10px] text-rose-600 font-medium truncate max-w-[120px]" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
