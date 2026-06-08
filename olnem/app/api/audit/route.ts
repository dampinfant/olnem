// GET /api/audit
//
// Returns audit log entries with optional filtering.
// Query params:
//   category   — "session_lifecycle" | "pipeline_error" | "operator_action"
//   sessionId  — filter to a specific session
//   limit      — max entries returned (default 200)
//   offset     — pagination offset (default 0)

import { readAuditLog, auditLogCount } from "@/lib/audit/log";
import type { AuditEventCategory } from "@/lib/audit/types";

const VALID_CATEGORIES = new Set([
  "session_lifecycle",
  "pipeline_error",
  "operator_action",
]);

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);

  const rawCategory = searchParams.get("category");
  const category: AuditEventCategory | undefined =
    rawCategory && VALID_CATEGORIES.has(rawCategory)
      ? (rawCategory as AuditEventCategory)
      : undefined;

  const sessionId = searchParams.get("sessionId") ?? undefined;

  const rawLimit = searchParams.get("limit");
  const limit = rawLimit ? Math.min(Math.max(1, parseInt(rawLimit, 10)), 500) : 200;

  const rawOffset = searchParams.get("offset");
  const offset = rawOffset ? Math.max(0, parseInt(rawOffset, 10)) : 0;

  const entries = readAuditLog({ category, sessionId, limit, offset });
  const total = auditLogCount();

  return Response.json({ entries, total, offset, limit });
}
