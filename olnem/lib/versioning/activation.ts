// C12 — Prompt version activation on session completion.
//
// Path A (default): revised prompts activate on session completion only.
// The pipeline calls activateOnSessionCompletion() immediately after end_turn,
// before writing the session_close audit entry. This means:
//   - The session_close audit records pre-activation prompt versions (what the
//     session actually used during evaluation).
//   - The next session will start with the newly activated versions.
//
// C8 exposes "Queue for next session" in the operator interface, which stores
// content in doc.pending. This function consumes and clears the pending field.

import { getAllDocuments, activatePendingVersion } from "@/lib/documents/registry";
import { appendAuditEvent } from "@/lib/audit/log";

export interface ActivationRecord {
  documentId: string;
  newVersion: number;
}

export function activateOnSessionCompletion(sessionId: string): ActivationRecord[] {
  const records: ActivationRecord[] = [];

  for (const doc of getAllDocuments()) {
    if (!doc.pending) continue;

    const newVersion = doc.pending.version;
    const activated = activatePendingVersion(doc.id);

    if (activated) {
      records.push({ documentId: doc.id, newVersion });
      appendAuditEvent({
        category: "operator_action",
        type: "prompt_version_activated_on_completion",
        timestamp: new Date().toISOString(),
        sessionId,
        documentId: doc.id,
        version: newVersion,
      });
    }
  }

  return records;
}
