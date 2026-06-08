"use client";

// Visualization + conclusion layer for a completed evaluation session.
//
// Fetches the full session state from GET /api/session/[id], then renders:
//   1. ConclusionLayer — mode-appropriate conclusion panel
//   2. ValidationGraph — directed graph of the full validation stack

import { useEffect, useState } from "react";
import type { SessionState } from "@/lib/session/schema";
import { ValidationGraph } from "@/app/components/ValidationGraph";
import { ConclusionLayer } from "@/app/components/ConclusionLayer";

type FetchState = "loading" | "ready" | "error";

export function SessionVisualization({ sessionId }: { sessionId: string }) {
  const [fetchState, setFetchState] = useState<FetchState>("loading");
  const [session, setSession] = useState<SessionState | null>(null);
  const [showGraph, setShowGraph] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/session/${sessionId}`);
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as SessionState;
        if (!cancelled) {
          setSession(data);
          setFetchState("ready");
        }
      } catch {
        if (!cancelled) setFetchState("error");
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [sessionId]);

  if (fetchState === "loading") {
    return (
      <div className="flex items-center gap-2 py-4">
        <span className="h-1 w-1 rounded-full bg-zinc-600 animate-pulse" />
        <span className="text-xs font-mono text-zinc-600">Loading evaluation output…</span>
      </div>
    );
  }

  if (fetchState === "error" || !session) {
    return (
      <p className="text-xs font-mono text-red-500 py-4">
        Failed to load session output.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {/* Conclusion layer — sits above the graph */}
      <ConclusionLayer session={session} />

      {/* Validation graph — directed view of the full stack */}
      <div>
        <button
          onClick={() => setShowGraph((v) => !v)}
          className="flex items-center gap-2 mb-4 text-[10px] font-mono text-zinc-500 hover:text-zinc-300 uppercase tracking-widest transition-colors"
        >
          <span>{showGraph ? "▾" : "▸"}</span>
          Validation stack graph
        </button>
        {showGraph && <ValidationGraph session={session} />}
      </div>
    </div>
  );
}
