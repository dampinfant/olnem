// POST /api/session/[id]/stop
//
// Signals the running pipeline to stop with the interrupted label.
// The pipeline emits session_interrupted into the open stream and closes it.
// Completed components are untouched. In-flight component is marked interrupted.

import { stopSession } from "@/lib/orchestration/control";
import { appendAuditEvent } from "@/lib/audit/log";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const ok = stopSession(id);
  if (ok) {
    appendAuditEvent({
      category: "operator_action",
      type: "session_stopped",
      timestamp: new Date().toISOString(),
      sessionId: id,
    });
  }
  return Response.json({ ok });
}
