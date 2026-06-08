// POST /api/session/[id]/respond
//
// Accepts the user's answer to a protocol-initiated question (waiting_for_input),
// injects it as the tool_result for the pending request_user_input call, and
// resumes the pipeline. Returns an NDJSON stream identical in structure to the
// initial evaluate stream — the client appends events to the existing block list.

import { getSession, updateSession } from "@/lib/session/store";
import {
  getConversation,
  refreshController,
  appendMessage,
  setConversationStatus,
} from "@/lib/session/conversation";
import { runConversationLoop } from "@/lib/orchestration/pipeline";
import { encodeStreamEvent } from "@/lib/contracts/output";
import type { StreamEvent } from "@/lib/contracts/output";
import { appendAuditEvent } from "@/lib/audit/log";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;

  let body: { answer: string };
  try {
    body = (await request.json()) as { answer: string };
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (typeof body.answer !== "string" || !body.answer.trim()) {
    return new Response("answer is required", { status: 400 });
  }

  const session = getSession(id);
  if (!session) return new Response("Session not found", { status: 404 });
  if (session.status !== "waiting_for_input") {
    return new Response(
      `Session is not waiting for input (current: ${session.status})`,
      { status: 400 }
    );
  }

  const { pendingQuestion } = session;
  if (!pendingQuestion) {
    return new Response("No pending question found on session", { status: 400 });
  }

  const conv = getConversation(id);
  if (!conv) return new Response("Conversation not found", { status: 404 });

  // Inject the user's answer as the tool_result for the pending tool_use block.
  appendMessage(id, {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: pendingQuestion.toolUseId,
        content: body.answer.trim(),
      },
    ],
  });

  // Clear the pending question and reset session status before resuming.
  updateSession(id, (s) => {
    s.status = "active";
    s.pendingQuestion = undefined;
  });

  const newController = refreshController(id);
  if (!newController) {
    return new Response("Failed to refresh abort controller", { status: 500 });
  }
  setConversationStatus(id, "running");

  appendAuditEvent({
    category: "operator_action",
    type: "session_resumed",
    timestamp: new Date().toISOString(),
    sessionId: id,
  });

  const encoder = new TextEncoder();
  const freshConv = getConversation(id)!;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onEvent = (event: StreamEvent): void => {
        try {
          controller.enqueue(encoder.encode(encodeStreamEvent(event)));
        } catch {}
      };

      runConversationLoop(id, freshConv.messages, freshConv.currentComponentId, onEvent)
        .then(() => {
          try { controller.close(); } catch {}
        })
        .catch((err: unknown) => {
          onEvent({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
            recoverable: false,
          });
          try { controller.close(); } catch {}
        });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-store",
    },
  });
}
