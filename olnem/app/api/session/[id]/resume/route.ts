// POST /api/session/[id]/resume
//
// Resumes a paused evaluation session. Returns an NDJSON stream that continues
// where the paused session left off. The client appends these events to the
// existing block list — session_created is not re-emitted.

import { resumeSession } from "@/lib/orchestration/control";
import { encodeStreamEvent } from "@/lib/contracts/output";
import type { StreamEvent } from "@/lib/contracts/output";
import { appendAuditEvent } from "@/lib/audit/log";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;

  appendAuditEvent({
    category: "operator_action",
    type: "session_resumed",
    timestamp: new Date().toISOString(),
    sessionId: id,
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const onEvent = (event: StreamEvent): void => {
        try {
          controller.enqueue(encoder.encode(encodeStreamEvent(event)));
        } catch {}
      };

      resumeSession(id, onEvent)
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
