"use client";

// C16 — Explanation button and inline explanation display.
//
// Self-contained: manages its own fetch state, caches the result,
// and renders the explanation inline below the block it annotates.
//
// The caller passes the text to explain explicitly — this component performs
// no session state lookups. It mirrors the isolation invariant of the
// explanation agent: the only input is what the caller explicitly provides.

import { useState } from "react";
import type { ExplainTargetType } from "@/lib/agents/explanation";

interface ExplainButtonProps {
  targetType: ExplainTargetType;
  text: string;
}

type FetchState = "idle" | "loading" | "done" | "error";

export function ExplainButton({ targetType, text }: ExplainButtonProps) {
  const [fetchState, setFetchState] = useState<FetchState>("idle");
  const [explanation, setExplanation] = useState<string>("");
  const [open, setOpen] = useState(false);

  const handleClick = async () => {
    setOpen(true);

    // Already fetched — just toggle open.
    if (fetchState === "done") return;
    if (fetchState === "loading") return;

    setFetchState("loading");
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType, text }),
      });

      if (!res.ok) {
        throw new Error(`${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as { explanation: string };
      setExplanation(data.explanation);
      setFetchState("done");
    } catch {
      setFetchState("error");
    }
  };

  const handleClose = () => setOpen(false);

  return (
    <div>
      <button
        onClick={handleClick}
        className="text-[10px] font-mono text-zinc-600 hover:text-violet-400 transition-colors"
      >
        {fetchState === "loading" ? "explaining…" : "explain"}
      </button>

      {open && (
        <div className="mt-2 pl-3 border-l border-violet-800/50">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-mono text-violet-400 uppercase tracking-widest">
              explanation
            </span>
            <button
              onClick={handleClose}
              className="text-[10px] font-mono text-zinc-700 hover:text-zinc-500 transition-colors"
            >
              close
            </button>
          </div>

          {fetchState === "loading" && (
            <div className="flex items-center gap-1.5">
              <span className="h-1 w-1 rounded-full bg-violet-500/60 animate-pulse" />
              <span className="text-xs font-mono text-zinc-600">thinking</span>
            </div>
          )}

          {fetchState === "done" && (
            <p className="text-xs font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap">
              {explanation}
            </p>
          )}

          {fetchState === "error" && (
            <p className="text-xs font-mono text-red-500">
              Explanation unavailable.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
