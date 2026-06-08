"use client";

// C6 — Streaming reasoning display with source-agent labels (self-managed mode).
//
// Accepts an idea string, starts the evaluation stream internally, and renders
// blocks using BlockList. Source-agent labels are set on each block from the
// stream events.
//
// For the operator page (C7), the stream is managed by useEvaluationStream and
// BlockList is used directly. This component exists for simpler embed use cases.

import { useEffect, useReducer, useRef } from "react";
import type { StreamEvent } from "@/lib/contracts/output";
import { decodeStreamEvent } from "@/lib/contracts/output";
import type { AgentRole } from "@/lib/documents/types";
import type { Block, EvaluationStatus } from "@/app/types/evaluation";
import { BlockList } from "@/app/components/BlockList";

// ─── State ────────────────────────────────────────────────────────────────────

interface DisplayState {
  sessionId: string | null;
  blocks: Block[];
  status: EvaluationStatus;
}

type Action =
  | { type: "RESET" }
  | { type: "SESSION_CREATED"; sessionId: string }
  | {
      type: "REASONING_CHUNK";
      componentId: string | null;
      text: string;
      sourceAgent: AgentRole;
    }
  | { type: "COMPONENT_CLASSIFIED"; componentId: string; classification: string; ground?: string }
  | { type: "VERIFICATION_SENT"; componentId: string }
  | {
      type: "VERIFICATION_RECEIVED";
      componentId: string;
      result: "confirmed" | "disputed";
      ground: string;
      flagCount: number;
      refinedClassification?: string;
    }
  | { type: "MODE_DETERMINED"; mode: string; subtype?: string }
  | { type: "PAUSED" }
  | { type: "INTERRUPTED" }
  | { type: "COMPLETED" }
  | { type: "ERROR"; message: string; recoverable: boolean };

function reducer(state: DisplayState, action: Action): DisplayState {
  switch (action.type) {
    case "RESET":
      return { sessionId: null, blocks: [], status: "idle" };

    case "SESSION_CREATED":
      return { ...state, sessionId: action.sessionId, status: "streaming" };

    case "REASONING_CHUNK": {
      const last = state.blocks[state.blocks.length - 1];
      if (
        last?.kind === "reasoning" &&
        last.componentId === action.componentId &&
        last.sourceAgent === action.sourceAgent
      ) {
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), { ...last, text: last.text + action.text }],
        };
      }
      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            kind: "reasoning",
            id: `reasoning-${state.blocks.length}`,
            sourceAgent: action.sourceAgent,
            componentId: action.componentId,
            text: action.text,
          },
        ],
      };
    }

    case "COMPONENT_CLASSIFIED":
      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            kind: "classified",
            id: `classified-${action.componentId}-${state.blocks.length}`,
            componentId: action.componentId,
            classification: action.classification,
            ground: action.ground,
          },
        ],
      };

    case "VERIFICATION_SENT":
      return {
        ...state,
        blocks: [
          ...state.blocks,
          { kind: "verifying", id: `verifying-${action.componentId}`, componentId: action.componentId },
        ],
      };

    case "VERIFICATION_RECEIVED": {
      const blocks = state.blocks.map((b) =>
        b.kind === "verifying" && b.componentId === action.componentId
          ? ({
              kind: "verified",
              id: `verified-${action.componentId}`,
              componentId: action.componentId,
              result: action.result,
              ground: action.ground,
              flagCount: action.flagCount,
              refinedClassification: action.refinedClassification,
            } as Block)
          : b
      );
      return { ...state, blocks };
    }

    case "MODE_DETERMINED":
      return {
        ...state,
        blocks: [
          ...state.blocks,
          { kind: "mode", id: `mode-${state.blocks.length}`, mode: action.mode, subtype: action.subtype },
        ],
      };

    case "PAUSED":
      return { ...state, status: "paused" };

    case "INTERRUPTED":
      return { ...state, status: "interrupted" };

    case "COMPLETED":
      return state.status === "paused" || state.status === "interrupted"
        ? state
        : { ...state, status: "completed" };

    case "ERROR":
      return {
        ...state,
        status: "error",
        blocks: [
          ...state.blocks,
          {
            kind: "error",
            id: `error-${state.blocks.length}`,
            message: action.message,
            recoverable: action.recoverable,
          },
        ],
      };

    default:
      return state;
  }
}

function dispatchFromEvent(dispatch: (a: Action) => void, event: StreamEvent): void {
  switch (event.type) {
    case "session_created":
      dispatch({ type: "SESSION_CREATED", sessionId: event.sessionId });
      break;
    case "reasoning_chunk":
      dispatch({ type: "REASONING_CHUNK", componentId: event.componentId, text: event.text, sourceAgent: event.sourceAgent });
      break;
    case "component_classified":
      dispatch({ type: "COMPONENT_CLASSIFIED", componentId: event.componentId, classification: event.classification, ground: event.resolutionGround });
      break;
    case "verification_sent":
      dispatch({ type: "VERIFICATION_SENT", componentId: event.componentId });
      break;
    case "verification_received":
      dispatch({ type: "VERIFICATION_RECEIVED", componentId: event.componentId, result: event.result, ground: event.ground, flagCount: event.flagCount, refinedClassification: event.refinedClassification });
      break;
    case "output_mode_determined":
      dispatch({ type: "MODE_DETERMINED", mode: event.mode, subtype: event.modeThreeSubtype });
      break;
    case "session_paused":
      dispatch({ type: "PAUSED" });
      break;
    case "session_interrupted":
      dispatch({ type: "INTERRUPTED" });
      break;
    case "error":
      dispatch({ type: "ERROR", message: event.message, recoverable: event.recoverable });
      break;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface ReasoningDisplayProps {
  idea: string;
  onComplete?: () => void;
  onError?: (message: string) => void;
}

export function ReasoningDisplay({ idea, onComplete, onError }: ReasoningDisplayProps) {
  const [state, dispatch] = useReducer(reducer, {
    sessionId: null,
    blocks: [],
    status: "idle",
  });

  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  onCompleteRef.current = onComplete;
  onErrorRef.current = onError;

  useEffect(() => {
    const trimmed = idea.trim();
    if (!trimmed) return;

    dispatch({ type: "RESET" });
    const abortController = new AbortController();

    async function startStream(): Promise<void> {
      let response: Response;
      try {
        response = await fetch("/api/evaluate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idea: trimmed }),
          signal: abortController.signal,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        const message = `Failed to start evaluation: ${err instanceof Error ? err.message : String(err)}`;
        dispatch({ type: "ERROR", message, recoverable: false });
        onErrorRef.current?.(message);
        return;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "unknown error");
        const message = `Server error ${response.status}: ${text}`;
        dispatch({ type: "ERROR", message, recoverable: false });
        onErrorRef.current?.(message);
        return;
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = decodeStreamEvent(line);
              dispatchFromEvent(dispatch, event);
              if (event.type === "error" && !event.recoverable) {
                onErrorRef.current?.(event.message);
              }
            } catch {
              // Malformed NDJSON line
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        dispatch({
          type: "ERROR",
          message: `Stream error: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: false,
        });
        return;
      }

      dispatch({ type: "COMPLETED" });
      onCompleteRef.current?.();
    }

    void startStream();
    return () => { abortController.abort(); };
  }, [idea]);

  if (state.status === "idle") return null;

  return (
    <div>
      <BlockList blocks={state.blocks} />

      {state.status === "streaming" && (
        <div className="flex items-center gap-2 mt-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
          <span className="text-[11px] font-mono text-zinc-600">evaluating</span>
        </div>
      )}

      {state.status === "paused" && (
        <p className="mt-2 text-[11px] font-mono text-zinc-600">session paused</p>
      )}

      {state.status === "interrupted" && (
        <p className="mt-2 text-[11px] font-mono text-zinc-600">session interrupted</p>
      )}
    </div>
  );
}
