// Shared types for evaluation stream state.
// Imported by both useEvaluationStream (hook) and BlockList (render).

import type { AgentRole } from "@/lib/documents/types";

export type EvaluationStatus =
  | "idle"
  | "streaming"
  | "waiting_for_input"
  | "paused"
  | "completed"
  | "interrupted"
  | "error";

export type Block =
  | {
      kind: "reasoning";
      id: string;
      sourceAgent: AgentRole;
      componentId: string | null;
      text: string;
    }
  | {
      kind: "classified";
      id: string;
      componentId: string;
      classification: string;
      ground?: string;
    }
  | { kind: "verifying"; id: string; componentId: string }
  | {
      kind: "verified";
      id: string;
      componentId: string;
      result: "confirmed" | "disputed";
      ground: string;
      flagCount: number;
      refinedClassification?: string;
    }
  | { kind: "mode"; id: string; mode: string; subtype?: string }
  | { kind: "error"; id: string; message: string; recoverable: boolean }
  | {
      kind: "question";
      id: string;
      question: string;
      questionType: "step0_quality" | "step0_framing" | "design_fork";
    };
