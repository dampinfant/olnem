// C15 — Audit log schema.
//
// Three event categories:
//   session_lifecycle — session_init and session_close
//   pipeline_error    — errors emitted from the evaluation pipeline
//   operator_action   — actions taken by the operator via the interface
//
// session_close required fields per specification:
//   terminal status, output mode (if applicable), prompt version IDs, timestamp.
//
// Append-only. The log module does not expose a delete function.

import type { OutputMode } from "@/lib/session/schema";

// ─── Shared ───────────────────────────────────────────────────────────────────

// Snapshot of active prompt versions at a point in time.
// Recorded at session_init and session_close (pre-C12-activation).
export interface PromptVersionSnapshot {
  main_agent: number;
  verification_agent: number;
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

export interface SessionInitAuditEvent {
  category: "session_lifecycle";
  type: "session_init";
  sessionId: string;
  timestamp: string;
  ideaLength: number;            // character count — not the idea text
  promptVersions: PromptVersionSnapshot;
}

export interface SessionCloseAuditEvent {
  category: "session_lifecycle";
  type: "session_close";
  sessionId: string;
  timestamp: string;
  // "terminal" excludes "paused" — a paused session can resume, so it is not closed.
  terminalStatus: "completed" | "interrupted" | "error";
  outputMode: OutputMode | null; // null when session ended before step_5
  // Versions active when the session ran, captured before C12 activation fires.
  promptVersions: PromptVersionSnapshot;
  durationMs: number | null;     // wall time from session creation to close
}

// ─── Pipeline errors ──────────────────────────────────────────────────────────

export interface PipelineErrorAuditEvent {
  category: "pipeline_error";
  type: "pipeline_error";
  sessionId: string;
  timestamp: string;
  message: string;
  recoverable: boolean;
  errorClass: string;  // err.name or "UnknownError"
}

// ─── Operator actions ─────────────────────────────────────────────────────────

export type OperatorActionType =
  | "session_submitted"
  | "session_paused"
  | "session_resumed"
  | "session_stopped"
  | "prompt_version_queued"
  | "prompt_version_activated_immediately" // manual override via "Activate now"
  | "prompt_version_activated_on_completion" // C12 — fired from pipeline on end_turn
  | "prompt_version_cleared";

export interface OperatorActionAuditEvent {
  category: "operator_action";
  type: OperatorActionType;
  timestamp: string;
  sessionId?: string;
  documentId?: string;
  version?: number;
}

// ─── Union ────────────────────────────────────────────────────────────────────

export type AuditEvent =
  | SessionInitAuditEvent
  | SessionCloseAuditEvent
  | PipelineErrorAuditEvent
  | OperatorActionAuditEvent;

export type AuditEventCategory = AuditEvent["category"];

export interface AuditLogEntry {
  entryId: string;
  event: AuditEvent;
}
