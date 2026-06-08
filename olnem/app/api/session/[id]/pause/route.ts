// POST /api/session/[id]/pause
//
// Signals the running evaluation pipeline to pause at the next safe boundary.
// The pipeline emits session_paused into the open evaluate stream, then closes it.
// Returns { ok: boolean } immediately — the client waits for the stream to close.

import { pauseSession } from "@/lib/orchestration/control";
import { appendAuditEvent } from "@/lib/audit/log";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const ok = pauseSession(id);
  if (ok) {
    appendAuditEvent({
      category: "operator_action",
      type: "session_paused",
      timestamp: new Date().toISOString(),
      sessionId: id,
    });
  }
  return Response.json({ ok });
}
