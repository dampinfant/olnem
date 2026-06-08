// Conversation state store — server-side only, never serialized to the client.
//
// Holds the Anthropic API messages array per session (needed for pause/resume)
// and the control intent (pause vs. stop) set by the control layer before
// signaling abort. Pipeline reads the intent from here to choose behavior.

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

export type ConversationStatus = "running" | "paused" | "waiting_for_input" | "stopped";

// Intent is set immediately before aborting, so the pipeline can read it
// in its abort handler and behave accordingly.
export type ControlIntent = "pause" | "stop";

export interface ConversationState {
  messages: MessageParam[];
  abortController: AbortController;
  status: ConversationStatus;
  currentComponentId: string | null;
  controlIntent: ControlIntent | null;
}

const g = global as typeof global & {
  _olnemConversations?: Map<string, ConversationState>;
};
const store: Map<string, ConversationState> =
  g._olnemConversations ?? (g._olnemConversations = new Map());

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function registerConversation(
  sessionId: string,
  initialMessages: MessageParam[]
): AbortController {
  const abortController = new AbortController();
  store.set(sessionId, {
    messages: initialMessages,
    abortController,
    status: "running",
    currentComponentId: null,
    controlIntent: null,
  });
  return abortController;
}

// Replace the AbortController on resume — the old one is spent.
export function refreshController(sessionId: string): AbortController | null {
  const conv = store.get(sessionId);
  if (!conv) return null;
  const abortController = new AbortController();
  conv.abortController = abortController;
  conv.status = "running";
  conv.controlIntent = null;
  return abortController;
}

export function deleteConversation(sessionId: string): void {
  store.delete(sessionId);
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export function getConversation(
  sessionId: string
): ConversationState | undefined {
  return store.get(sessionId);
}

// ─── Writes ───────────────────────────────────────────────────────────────────

// Called at the top of each pipeline loop turn so the latest messages are
// always available for a mid-turn pause recovery.
export function saveMessages(
  sessionId: string,
  messages: MessageParam[],
  currentComponentId: string | null
): void {
  const conv = store.get(sessionId);
  if (!conv) return;
  conv.messages = messages;
  conv.currentComponentId = currentComponentId;
}

export function setConversationStatus(
  sessionId: string,
  status: ConversationStatus
): void {
  const conv = store.get(sessionId);
  if (conv) conv.status = status;
}

// Set the intent immediately before signaling abort.
// The pipeline abort handler reads this to decide between pause and stop.
export function setControlIntent(
  sessionId: string,
  intent: ControlIntent
): void {
  const conv = store.get(sessionId);
  if (conv) conv.controlIntent = intent;
}

export function clearControlIntent(sessionId: string): void {
  const conv = store.get(sessionId);
  if (conv) conv.controlIntent = null;
}

// Append a single message to the saved messages array.
// Called by the respond endpoint to inject the user's answer as a tool result.
export function appendMessage(
  sessionId: string,
  message: MessageParam
): void {
  const conv = store.get(sessionId);
  if (!conv) return;
  conv.messages = [...conv.messages, message];
}
