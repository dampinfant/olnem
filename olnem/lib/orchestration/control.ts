// C3 (pause/resume) and C4 (stop with interrupted label).
//
// Dependency graph — no cycles:
//   conversation.ts ← errors.ts (none)
//   control.ts      ← conversation.ts, pipeline.ts (runConversationLoop)
//   pipeline.ts     ← conversation.ts, errors.ts
//
// The pipeline does NOT import control.ts. It reads the control intent
// directly from conversation.ts on abort.

import type { StreamEvent } from "@/lib/contracts/output";
import {
  getConversation,
  refreshController,
  setControlIntent,
  clearControlIntent,
  setConversationStatus,
} from "@/lib/session/conversation";
import { updateSession } from "@/lib/session/store";
// One-way import: control.ts → pipeline.ts. Pipeline does NOT import control.ts.
import { runConversationLoop } from "@/lib/orchestration/pipeline";

// ─── C3: Pause ────────────────────────────────────────────────────────────────
//
// Sets intent to "pause" before signaling abort.
// The pipeline loop reads the intent in its abort handler and exits without
// marking the session interrupted — it leaves session status as "paused"
// and conversation state intact.
//
// Returns false if the session is not currently running.

export function pauseSession(sessionId: string): boolean {
  const conv = getConversation(sessionId);
  if (!conv || conv.status !== "running") return false;

  // Set intent and both status fields BEFORE abort. The pipeline abort handler
  // reads the intent and relies on these being set already when it runs.
  setControlIntent(sessionId, "pause");
  setConversationStatus(sessionId, "paused");
  updateSession(sessionId, (s) => {
    s.status = "paused";
  });
  conv.abortController.abort();
  return true;
}

// ─── C3: Resume ──────────────────────────────────────────────────────────────
//
// Replaces the spent AbortController, resets session status to active,
// then continues the conversation loop from the saved messages array.

export async function resumeSession(
  sessionId: string,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  const conv = getConversation(sessionId);

  if (!conv || conv.status !== "paused") {
    onEvent({
      type: "error",
      message: `Cannot resume session ${sessionId}: not in paused state (current: ${conv?.status ?? "not found"})`,
      recoverable: false,
    });
    return;
  }

  // Swap in a fresh controller — the previous one was aborted.
  const newController = refreshController(sessionId);
  if (!newController) {
    onEvent({
      type: "error",
      message: `Failed to refresh controller for session ${sessionId}`,
      recoverable: false,
    });
    return;
  }

  clearControlIntent(sessionId);
  updateSession(sessionId, (s) => {
    s.status = "active";
  });

  await runConversationLoop(
    sessionId,
    conv.messages,
    conv.currentComponentId,
    onEvent
  );
}

// ─── C4: Stop with interrupted label ─────────────────────────────────────────
//
// Sets intent to "stop" before signaling abort.
// The pipeline's abort handler will:
//   1. Mark the in-flight component status as "interrupted"
//   2. Mark the session status as "interrupted"
//   3. Emit a session_interrupted StreamEvent
//   4. Exit the loop
//
// Completed components are untouched — they retain their verified status.
//
// Returns false if the session is not running or already stopped.

export function stopSession(sessionId: string): boolean {
  const conv = getConversation(sessionId);
  if (!conv || conv.status === "stopped") return false;

  setControlIntent(sessionId, "stop");
  setConversationStatus(sessionId, "stopped");
  conv.abortController.abort();
  return true;
}
