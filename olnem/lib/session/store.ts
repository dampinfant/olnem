// Session store — in-memory singleton, persistent across Next.js HMR reloads.

import type {
  SessionState,
  SessionStore,
  ValidationLayer,
} from "@/lib/session/schema";

// Global fallback ensures the Map survives hot module replacement in development.
const g = global as typeof global & { _olnemStore?: SessionStore };
const store: SessionStore = g._olnemStore ?? (g._olnemStore = new Map());

// ─── Factory ─────────────────────────────────────────────────────────────────

function initialSessionState(id: string, ideaSubmission: string): SessionState {
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    ideaSubmission,

    inputGate: { passed: null },

    framingOrientation: {
      isVerdictSeeking: null,
      priorAttemptsAvailable: null,
      passed: null,
    },

    ideaType: null,
    constraintType: null,
    hasEmergenceMarkers: false,
    hasWickedProblemMarkers: false,
    validationLayers: [] as ValidationLayer[],

    decomposition: {
      components: [],
      omissionCheck: {
        embeddedAssumptions: false,
        implicitDependencies: false,
        expertObvious: false,
      },
    },

    scopeForks: [],
    outputMode: null,
    status: "active",
    finalOutput: null,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function createSession(ideaSubmission: string): SessionState {
  const id = crypto.randomUUID();
  const session = initialSessionState(id, ideaSubmission);
  store.set(id, session);
  return session;
}

export function getSession(id: string): SessionState | undefined {
  return store.get(id);
}

// updater receives the live state object and mutates it directly.
// Returns false if the session does not exist.
export function updateSession(
  id: string,
  updater: (s: SessionState) => void
): boolean {
  const session = store.get(id);
  if (!session) return false;
  updater(session);
  session.updatedAt = new Date().toISOString();
  return true;
}

export function deleteSession(id: string): void {
  store.delete(id);
}

export function sessionCount(): number {
  return store.size;
}
