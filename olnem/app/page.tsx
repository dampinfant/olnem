"use client";

// C7 — Operator interface.
//
// Single-page evaluation surface. The operator enters an idea, watches the
// evaluation stream in real time, and controls the session (pause/resume/stop).
// The Documents panel (C8) is toggled from the header.

import { useCallback, useRef, useState } from "react";
import { useEvaluationStream } from "@/app/hooks/useEvaluationStream";
import { BlockList } from "@/app/components/BlockList";
import { DocumentsPanel } from "@/app/components/DocumentsPanel";
import { AuditPanel } from "@/app/components/AuditPanel";
import { SessionVisualization } from "@/app/components/SessionVisualization";

// ─── Idea input ───────────────────────────────────────────────────────────────

function IdeaInput({
  onSubmit,
  disabled,
}: {
  onSubmit: (idea: string) => void;
  disabled?: boolean;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
  }, [value, disabled, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div className="space-y-3">
      <label className="block text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
        Idea
      </label>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder="Describe the specific mechanism or approach to evaluate..."
        rows={5}
        className="w-full text-sm font-mono text-zinc-200 bg-zinc-900 border border-zinc-700 rounded-lg p-4 resize-y focus:outline-none focus:border-zinc-500 placeholder-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      />
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono text-zinc-700">⌘↵ to submit</span>
        <button
          onClick={handleSubmit}
          disabled={!value.trim() || disabled}
          className="px-5 py-2 text-sm font-mono text-zinc-900 bg-zinc-100 hover:bg-white rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Evaluate
        </button>
      </div>
    </div>
  );
}

// ─── Session controls ─────────────────────────────────────────────────────────

function SessionControls({
  status,
  onPause,
  onResume,
  onStop,
  onNew,
}: {
  status: string;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onNew: () => void;
}) {
  if (status === "waiting_for_input") {
    return null; // ProtocolQuestion in the block area handles input; no controls needed
  }

  if (status === "streaming") {
    return (
      <div className="flex items-center gap-4">
        <button
          onClick={onPause}
          className="text-xs font-mono text-zinc-400 hover:text-zinc-200 border border-zinc-700 hover:border-zinc-500 rounded px-3 py-1.5 transition-colors"
        >
          Pause
        </button>
        <button
          onClick={onStop}
          className="text-xs font-mono text-zinc-600 hover:text-red-400 transition-colors"
        >
          Stop
        </button>
      </div>
    );
  }

  if (status === "paused") {
    return (
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 mr-2">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          <span className="text-[11px] font-mono text-amber-400">paused</span>
        </div>
        <button
          onClick={onResume}
          className="text-xs font-mono text-zinc-200 hover:text-white border border-zinc-600 hover:border-zinc-400 rounded px-3 py-1.5 transition-colors"
        >
          Resume
        </button>
        <button
          onClick={onStop}
          className="text-xs font-mono text-zinc-600 hover:text-red-400 transition-colors"
        >
          Stop
        </button>
      </div>
    );
  }

  if (status === "completed" || status === "interrupted" || status === "error") {
    return (
      <div className="flex items-center gap-4">
        {status === "completed" && (
          <span className="text-[11px] font-mono text-emerald-400">completed</span>
        )}
        {status === "interrupted" && (
          <span className="text-[11px] font-mono text-zinc-500">interrupted</span>
        )}
        {status === "error" && (
          <span className="text-[11px] font-mono text-red-400">error</span>
        )}
        <button
          onClick={onNew}
          className="text-xs font-mono text-zinc-400 hover:text-zinc-200 border border-zinc-700 hover:border-zinc-500 rounded px-3 py-1.5 transition-colors"
        >
          New evaluation
        </button>
      </div>
    );
  }

  return null;
}

// ─── Status pill ──────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  if (status === "idle") return null;

  const configs: Record<string, { dot: string; label: string; text: string }> = {
    streaming: { dot: "bg-blue-500 animate-pulse", label: "evaluating", text: "text-blue-400" },
    waiting_for_input: { dot: "bg-amber-500 animate-pulse", label: "awaiting input", text: "text-amber-400" },
    paused: { dot: "bg-amber-500", label: "paused", text: "text-amber-400" },
    completed: { dot: "bg-emerald-500", label: "done", text: "text-emerald-400" },
    interrupted: { dot: "bg-zinc-500", label: "interrupted", text: "text-zinc-400" },
    error: { dot: "bg-red-500", label: "error", text: "text-red-400" },
  };

  const config = configs[status];
  if (!config) return null;

  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${config.dot}`} />
      <span className={`text-[10px] font-mono uppercase tracking-widest ${config.text}`}>
        {config.label}
      </span>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// ─── Protocol question UI ─────────────────────────────────────────────────────

function ProtocolQuestion({
  question,
  onSubmit,
}: {
  question: string;
  onSubmit: (answer: string) => void;
}) {
  const [value, setValue] = useState("");

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }, [value, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 p-4 space-y-3">
      <p className="text-[10px] font-mono text-amber-400/70 uppercase tracking-widest">
        Question required to continue
      </p>
      <p className="text-sm font-mono text-zinc-200 leading-relaxed">{question}</p>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Your answer..."
        rows={3}
        className="w-full text-sm font-mono text-zinc-200 bg-zinc-900 border border-zinc-700 rounded-lg p-3 resize-y focus:outline-none focus:border-amber-600/60 placeholder-zinc-700 transition-colors"
        autoFocus
      />
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono text-zinc-700">⌘↵ to submit</span>
        <button
          onClick={handleSubmit}
          disabled={!value.trim()}
          className="px-4 py-1.5 text-sm font-mono text-zinc-900 bg-amber-400 hover:bg-amber-300 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OperatorPage() {
  const { state, submit, pause, resume, respond, stop, reset } = useEvaluationStream();
  const [showDocs, setShowDocs] = useState(false);
  const [showAudit, setShowAudit] = useState(false);

  const handleSubmit = useCallback(
    (idea: string) => {
      submit(idea);
    },
    [submit]
  );

  const handleNew = useCallback(() => {
    reset();
  }, [reset]);

  const isIdle = state.status === "idle";
  const isDone =
    state.status === "completed" ||
    state.status === "interrupted" ||
    state.status === "error";
  const isActive =
    state.status === "streaming" ||
    state.status === "paused" ||
    state.status === "waiting_for_input";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-zinc-800/60 bg-zinc-950/95 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span className="text-sm font-mono text-zinc-100 tracking-tight">olnem</span>
            <StatusPill status={state.status} />
          </div>
          <div className="flex items-center gap-3">
            {state.sessionId && (
              <span className="text-[10px] font-mono text-zinc-700 hidden sm:block">
                {state.sessionId.slice(0, 8)}
              </span>
            )}
            <button
              onClick={() => setShowDocs((v) => !v)}
              className={`text-xs font-mono transition-colors border rounded px-3 py-1.5 ${
                showDocs
                  ? "text-zinc-200 border-zinc-500"
                  : "text-zinc-500 hover:text-zinc-300 border-zinc-700 hover:border-zinc-600"
              }`}
            >
              Documents
            </button>
            <button
              onClick={() => setShowAudit((v) => !v)}
              className={`text-xs font-mono transition-colors border rounded px-3 py-1.5 ${
                showAudit
                  ? "text-zinc-200 border-zinc-500"
                  : "text-zinc-500 hover:text-zinc-300 border-zinc-700 hover:border-zinc-600"
              }`}
            >
              Audit
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        {/* Idea input — shown when idle or done */}
        {(isIdle || isDone) && (
          <IdeaInput onSubmit={handleSubmit} disabled={state.status === "streaming"} />
        )}

        {/* Evaluation stream */}
        {(isActive || isDone) && state.blocks.length > 0 && (
          <div>
            {isDone && (
              <div className="mb-6 border-t border-zinc-800/60" />
            )}
            <BlockList blocks={state.blocks} />
          </div>
        )}

        {/* Protocol question — shown when pipeline is waiting for user input */}
        {state.status === "waiting_for_input" && state.pendingQuestion && (
          <ProtocolQuestion
            question={state.pendingQuestion.question}
            onSubmit={respond}
          />
        )}

        {/* Visualization + conclusion — shown on completion */}
        {state.status === "completed" && state.sessionId && (
          <div className="border-t border-zinc-800/60 pt-8">
            <SessionVisualization sessionId={state.sessionId} />
          </div>
        )}

        {/* Session controls — shown when a session is active */}
        {(isActive || isDone) && (
          <div className="pt-2 border-t border-zinc-800/40">
            <SessionControls
              status={state.status}
              onPause={() => void pause()}
              onResume={() => resume()}
              onStop={() => void stop()}
              onNew={handleNew}
            />
          </div>
        )}

        {/* Documents panel */}
        {showDocs && (
          <div className="pt-6 border-t border-zinc-800/60">
            <div className="flex items-center justify-between mb-4">
              <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
                Documents
              </p>
              <button
                onClick={() => setShowDocs(false)}
                className="text-[11px] font-mono text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                Close
              </button>
            </div>
            <DocumentsPanel />
          </div>
        )}

        {/* Audit panel */}
        {showAudit && (
          <div className="pt-6 border-t border-zinc-800/60">
            <div className="flex items-center justify-between mb-4">
              <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
                Audit Log
              </p>
              <button
                onClick={() => setShowAudit(false)}
                className="text-[11px] font-mono text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                Close
              </button>
            </div>
            <AuditPanel />
          </div>
        )}
      </main>
    </div>
  );
}
