// POST /api/evaluate
//
// Starts a new evaluation session and streams all protocol events to the client
// as newline-delimited JSON (NDJSON) over a ReadableStream.
//
// The stream stays open for the full duration of the evaluation pipeline.
// The first event is always session_created — the client reads the session ID
// from it for any subsequent control operations (C7).

import { createSession } from "@/lib/session/store";
import { runEvaluationSession } from "@/lib/orchestration/pipeline";
import { encodeStreamEvent } from "@/lib/contracts/output";
import type { StreamEvent } from "@/lib/contracts/output";
import { appendAuditEvent } from "@/lib/audit/log";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("idea" in body) ||
    typeof (body as Record<string, unknown>).idea !== "string" ||
    !(body as { idea: string }).idea.trim()
  ) {
    return new Response("Missing or invalid 'idea' field", { status: 400 });
  }

  const idea = (body as { idea: string }).idea.trim();
  const session = createSession(idea);

  appendAuditEvent({
    category: "operator_action",
    type: "session_submitted",
    timestamp: new Date().toISOString(),
    sessionId: session.id,
  });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onEvent = (event: StreamEvent): void => {
        try {
          controller.enqueue(encoder.encode(encodeStreamEvent(event)));
        } catch {
          // Ignore — controller already closed (client disconnected mid-stream)
        }
      };

      // Pipeline runs asynchronously. The stream stays open until it completes.
      runEvaluationSession(session.id, idea, onEvent)
        .then(() => {
          try {
            controller.close();
          } catch {}
        })
        .catch((err: unknown) => {
          onEvent({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
            recoverable: false,
          });
          try {
            controller.close();
          } catch {}
        });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
