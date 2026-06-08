// C15 — Append-only audit log.
//
// Uses the same HMR-safe global singleton pattern as the session store.
// No delete function is provided — append-only is a hard invariant.

import type {
  AuditEvent,
  AuditEventCategory,
  AuditLogEntry,
} from "@/lib/audit/types";

const g = global as typeof global & { _olnemAuditLog?: AuditLogEntry[] };
const log: AuditLogEntry[] =
  g._olnemAuditLog ?? (g._olnemAuditLog = []);

// ─── Write ────────────────────────────────────────────────────────────────────

export function appendAuditEvent(event: AuditEvent): void {
  log.push({ entryId: crypto.randomUUID(), event });
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export interface AuditReadOptions {
  category?: AuditEventCategory;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export function readAuditLog(options: AuditReadOptions = {}): AuditLogEntry[] {
  let result: AuditLogEntry[] = log;

  if (options.category) {
    result = result.filter((e) => e.event.category === options.category);
  }

  if (options.sessionId) {
    result = result.filter((e) => {
      const ev = e.event;
      if (ev.category === "session_lifecycle") return ev.sessionId === options.sessionId;
      if (ev.category === "pipeline_error") return ev.sessionId === options.sessionId;
      if (ev.category === "operator_action") return ev.sessionId === options.sessionId;
      return false;
    });
  }

  const offset = options.offset ?? 0;
  const limit = options.limit ?? 200;
  return result.slice(offset, offset + limit);
}

export function auditLogCount(): number {
  return log.length;
}
