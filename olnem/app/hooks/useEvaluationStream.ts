"use client";

// C7 — Evaluation stream hook.
//
// Manages the full session lifecycle for the operator page:
//   submit(idea) → starts a new evaluation, streams into block list
//   pause()      → signals server to pause; stream closes with session_paused
//   resume()     → opens resume stream; blocks continue accumulating
//   stop()       → signals server to stop; stream closes with session_interrupted
//   reset()      → clears all state back to idle
//
// The operator page renders blocks from state.blocks using BlockList and
// wires the control functions to the session control buttons.

import { useCallback, useReducer, useRef } from "react";
import type { StreamEvent } from "@/lib/contracts/output";
import { decodeStreamEvent } from "@/lib/contracts/output";
import type { Block, EvaluationStatus } from "@/app/types/evaluation";
import type { AgentRole } from "@/lib/documents/types";

export type { EvaluationStatus };
export type { Block };

// ─── State ────────────────────────────────────────────────────────────────────

export interface EvaluationStreamState {
  sessionId: string | null;
  blocks: Block[];
  status: EvaluationStatus;
  pendingQuestion: { question: string; questionType: "step0_quality" | "step0_framing" | "design_fork" } | null;
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

type Action =
  | { type: "RESET" }
  | { type: "STREAM_STARTED" }
  | { type: "RESUME_STARTED" }
  | { type: "SESSION_CREATED"; sessionId: string }
  | { type: "AWAITING_INPUT"; question: string; questionType: "step0_quality" | "step0_framing" | "design_fork" }
  | { type: "RESPOND_STARTED" }
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
  | { type: "STREAM_ENDED" }
  | { type: "ERROR"; message: string; recoverable: boolean };

const INITIAL_STATE: EvaluationStreamState = {
  sessionId: null,
  blocks: [],
  status: "idle",
  pendingQuestion: null,
};

function nextBlockId(blocks: Block[]): string {
  return String(blocks.length);
}

function reducer(state: EvaluationStreamState, action: Action): EvaluationStreamState {
  switch (action.type) {
    case "RESET":
      return { ...INITIAL_STATE };

    case "STREAM_STARTED":
      return { ...INITIAL_STATE, status: "streaming" };

    // Resume keeps existing sessionId and blocks — only resets status.
    case "RESUME_STARTED":
      return { ...state, status: "streaming" };

    // Respond keeps existing sessionId and blocks; clears pending question.
    case "RESPOND_STARTED":
      return { ...state, status: "streaming", pendingQuestion: null };

    case "AWAITING_INPUT":
      return {
        ...state,
        status: "waiting_for_input",
        pendingQuestion: { question: action.question, questionType: action.questionType },
        blocks: [
          ...state.blocks,
          {
            kind: "question" as const,
            id: nextBlockId(state.blocks),
            question: action.question,
            questionType: action.questionType,
          },
        ],
      };

    case "SESSION_CREATED":
      return { ...state, sessionId: action.sessionId };

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
            id: nextBlockId(state.blocks),
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
            id: nextBlockId(state.blocks),
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
          {
            kind: "verifying",
            id: `verifying-${action.componentId}`,
            componentId: action.componentId,
          },
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
          {
            kind: "mode",
            id: nextBlockId(state.blocks),
            mode: action.mode,
            subtype: action.subtype,
          },
        ],
      };

    case "PAUSED":
      return { ...state, status: "paused" };

    case "INTERRUPTED":
      return { ...state, status: "interrupted" };

    // Only advance to "completed" when the stream ends naturally mid-run.
    // If already paused/interrupted/errored, the state is settled — don't overwrite.
    case "STREAM_ENDED":
      return state.status === "streaming"
        ? { ...state, status: "completed" }
        : state;

    case "ERROR":
      return {
        ...state,
        status: "error",
        blocks: [
          ...state.blocks,
          {
            kind: "error",
            id: nextBlockId(state.blocks),
            message: action.message,
            recoverable: action.recoverable,
          },
        ],
      };

    default:
      return state;
  }
}

// ─── Stream event → action ────────────────────────────────────────────────────

function buildAction(event: StreamEvent): Action | null {
  switch (event.type) {
    case "session_created":
      return { type: "SESSION_CREATED", sessionId: event.sessionId };
    case "reasoning_chunk":
      return {
        type: "REASONING_CHUNK",
        componentId: event.componentId,
        text: event.text,
        sourceAgent: event.sourceAgent,
      };
    case "component_classified":
      return {
        type: "COMPONENT_CLASSIFIED",
        componentId: event.componentId,
        classification: event.classification,
        ground: event.resolutionGround,
      };
    case "verification_sent":
      return { type: "VERIFICATION_SENT", componentId: event.componentId };
    case "verification_received":
      return {
        type: "VERIFICATION_RECEIVED",
        componentId: event.componentId,
        result: event.result,
        ground: event.ground,
        flagCount: event.flagCount,
        refinedClassification: event.refinedClassification,
      };
    case "output_mode_determined":
      return { type: "MODE_DETERMINED", mode: event.mode, subtype: event.modeThreeSubtype };
    case "awaiting_input":
      return { type: "AWAITING_INPUT", question: event.question, questionType: event.questionType };
    case "session_paused":
      return { type: "PAUSED" };
    case "session_interrupted":
      return { type: "INTERRUPTED" };
    case "error":
      return { type: "ERROR", message: event.message, recoverable: event.recoverable };
    default:
      return null;
  }
}

// ─── Stream reader ────────────────────────────────────────────────────────────

async function readStream(
  response: Response,
  dispatch: (a: Action) => void
): Promise<void> {
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
          const action = buildAction(event);
          if (action) dispatch(action);
        } catch {
          // Malformed NDJSON line — skip
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

  dispatch({ type: "STREAM_ENDED" });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useEvaluationStream() {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const sessionIdRef = useRef<string | null>(null);

  // Update sessionId ref whenever state.sessionId changes.
  // Use ref so pause/resume/stop closures always see the current session ID.
  if (state.sessionId !== sessionIdRef.current) {
    sessionIdRef.current = state.sessionId;
  }

  const connect = useCallback(
    (url: string, init: RequestInit, isResume: boolean) => {
      dispatch(isResume ? { type: "RESUME_STARTED" } : { type: "STREAM_STARTED" });

      fetch(url, init)
        .then((response) => {
          if (!response.ok) {
            return response.text().then((text) => {
              throw new Error(`Server error ${response.status}: ${text}`);
            });
          }
          return readStream(response, dispatch);
        })
        .catch((err: unknown) => {
          if ((err as Error).name !== "AbortError") {
            dispatch({
              type: "ERROR",
              message: err instanceof Error ? err.message : String(err),
              recoverable: false,
            });
          }
        });
    },
    []
  );

  const submit = useCallback(
    (idea: string) => {
      connect(
        "/api/evaluate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idea }),
        },
        false
      );
    },
    [connect]
  );

  const pause = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    await fetch(`/api/session/${sid}/pause`, { method: "POST" }).catch(() => {});
    // stream_paused event closes the stream; reducer sets status to "paused"
  }, []);

  const resume = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    connect(`/api/session/${sid}/resume`, { method: "POST" }, true);
  }, [connect]);

  const stop = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    await fetch(`/api/session/${sid}/stop`, { method: "POST" }).catch(() => {});
    // session_interrupted event closes the stream; reducer sets status to "interrupted"
  }, []);

  const respond = useCallback(
    (answer: string) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      dispatch({ type: "RESPOND_STARTED" });
      connect(
        `/api/session/${sid}/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer }),
        },
        true
      );
    },
    [connect]
  );

  const reset = useCallback(() => {
    dispatch({ type: "RESET" });
    sessionIdRef.current = null;
  }, []);

  return { state, submit, pause, resume, respond, stop, reset };
}
