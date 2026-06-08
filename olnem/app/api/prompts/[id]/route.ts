// GET  /api/prompts/[id] — fetch a single document record
// PUT  /api/prompts/[id] — queue a pending version update
//   body: { content: string; version: number; activate?: boolean }
//   When activate = true, the new content is activated immediately.
//   When activate = false (default), it is queued as pending.
//   C12 (versioning activation) will trigger activation on session completion;
//   the activate flag is available for manual override / testing.

import {
  getDocument,
  queuePendingVersion,
  activatePendingVersion,
  clearPendingVersion,
} from "@/lib/documents/registry";
import { appendAuditEvent } from "@/lib/audit/log";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const doc = getDocument(id);
  if (!doc) return new Response("Document not found", { status: 404 });
  return Response.json(doc);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as Record<string, unknown>).content !== "string" ||
    typeof (body as Record<string, unknown>).version !== "number"
  ) {
    return new Response("Body must include { content: string; version: number }", {
      status: 400,
    });
  }

  const { content, version, activate = false } = body as {
    content: string;
    version: number;
    activate?: boolean;
  };

  const queued = queuePendingVersion(id, content, version);
  if (!queued) return new Response("Document not found", { status: 404 });

  if (activate) {
    activatePendingVersion(id);
    appendAuditEvent({
      category: "operator_action",
      type: "prompt_version_activated_immediately",
      timestamp: new Date().toISOString(),
      documentId: id,
      version,
    });
    return Response.json({ ok: true, activated: true });
  }

  appendAuditEvent({
    category: "operator_action",
    type: "prompt_version_queued",
    timestamp: new Date().toISOString(),
    documentId: id,
    version,
  });
  return Response.json({ ok: true, activated: false, pendingVersion: version });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params;
  const cleared = clearPendingVersion(id);
  if (cleared) {
    appendAuditEvent({
      category: "operator_action",
      type: "prompt_version_cleared",
      timestamp: new Date().toISOString(),
      documentId: id,
    });
  }
  return Response.json({ ok: cleared });
}
