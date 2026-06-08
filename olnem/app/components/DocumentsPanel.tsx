"use client";

// C8 — Documents panel for the operator interface.
//
// Shows all prompt documents from the registry. Allows the operator to:
//   - View the current active content of each document
//   - Queue a new version (stored as pending; activates on session completion per C12)
//   - Activate a queued version immediately (for testing; C12 automates this)
//   - Clear a queued version
//
// Used in app/page.tsx as a slide-in panel toggled by the Documents button.

import { useCallback, useEffect, useReducer } from "react";
import type { DocumentRecord } from "@/lib/documents/types";

// ─── State ────────────────────────────────────────────────────────────────────

interface PanelState {
  documents: DocumentRecord[];
  loading: boolean;
  expandedId: string | null;
  editingId: string | null;
  editContent: string;
  editVersion: string;
  saving: Record<string, boolean>;
  error: string | null;
}

type PanelAction =
  | { type: "LOADED"; documents: DocumentRecord[] }
  | { type: "LOAD_ERROR"; message: string }
  | { type: "TOGGLE_EXPAND"; id: string }
  | { type: "START_EDIT"; id: string; currentContent: string; currentVersion: number }
  | { type: "CANCEL_EDIT" }
  | { type: "SET_CONTENT"; content: string }
  | { type: "SET_VERSION"; version: string }
  | { type: "SAVING"; id: string }
  | { type: "SAVED"; document: DocumentRecord }
  | { type: "SAVE_ERROR"; message: string }
  | { type: "ACTIVATING"; id: string }
  | { type: "ACTIVATED"; document: DocumentRecord }
  | { type: "CLEARING"; id: string }
  | { type: "CLEARED"; id: string };

function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "LOADED":
      return { ...state, documents: action.documents, loading: false, error: null };
    case "LOAD_ERROR":
      return { ...state, loading: false, error: action.message };
    case "TOGGLE_EXPAND":
      return {
        ...state,
        expandedId: state.expandedId === action.id ? null : action.id,
        editingId: state.editingId === action.id ? null : state.editingId,
      };
    case "START_EDIT":
      return {
        ...state,
        editingId: action.id,
        editContent: action.currentContent,
        editVersion: String(action.currentVersion + 1),
      };
    case "CANCEL_EDIT":
      return { ...state, editingId: null, editContent: "", editVersion: "" };
    case "SET_CONTENT":
      return { ...state, editContent: action.content };
    case "SET_VERSION":
      return { ...state, editVersion: action.version };
    case "SAVING":
    case "ACTIVATING":
    case "CLEARING":
      return { ...state, saving: { ...state.saving, [action.id]: true } };
    case "SAVED":
    case "ACTIVATED":
    case "CLEARED": {
      const id = action.type === "CLEARED" ? action.id : action.document.id;
      const newDocs =
        action.type === "CLEARED"
          ? state.documents.map((d) =>
              d.id === id ? { ...d, pending: undefined } : d
            )
          : state.documents.map((d) =>
              d.id === action.document.id ? action.document : d
            );
      return {
        ...state,
        documents: newDocs,
        saving: { ...state.saving, [id]: false },
        editingId: state.editingId === id ? null : state.editingId,
        editContent: state.editingId === id ? "" : state.editContent,
        editVersion: state.editingId === id ? "" : state.editVersion,
        error: null,
      };
    }
    case "SAVE_ERROR":
      return {
        ...state,
        error: action.message,
        saving: Object.fromEntries(
          Object.entries(state.saving).map(([k]) => [k, false])
        ),
      };
    default:
      return state;
  }
}

// ─── DocumentsPanel ───────────────────────────────────────────────────────────

export function DocumentsPanel() {
  const [state, dispatch] = useReducer(panelReducer, {
    documents: [],
    loading: true,
    expandedId: null,
    editingId: null,
    editContent: "",
    editVersion: "",
    saving: {},
    error: null,
  });

  useEffect(() => {
    fetch("/api/prompts")
      .then((r) => r.json() as Promise<DocumentRecord[]>)
      .then((docs) => dispatch({ type: "LOADED", documents: docs }))
      .catch((err: unknown) =>
        dispatch({
          type: "LOAD_ERROR",
          message: err instanceof Error ? err.message : "Failed to load documents",
        })
      );
  }, []);

  const queueUpdate = useCallback(
    async (id: string, activate: boolean) => {
      const version = parseInt(state.editVersion, 10);
      if (isNaN(version) || !state.editContent.trim()) return;

      dispatch({ type: "SAVING", id });
      try {
        const r = await fetch(`/api/prompts/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: state.editContent,
            version,
            activate,
          }),
        });
        if (!r.ok) throw new Error(`Server error ${r.status}`);
        // Refresh the document record
        const updated = (await fetch(`/api/prompts/${id}`).then((x) =>
          x.json()
        )) as DocumentRecord;
        dispatch({ type: "SAVED", document: updated });
      } catch (err) {
        dispatch({
          type: "SAVE_ERROR",
          message: err instanceof Error ? err.message : "Save failed",
        });
      }
    },
    [state.editContent, state.editVersion]
  );

  const activatePending = useCallback(async (id: string) => {
    dispatch({ type: "ACTIVATING", id });
    try {
      const doc = state.documents.find((d) => d.id === id);
      if (!doc?.pending) return;
      const r = await fetch(`/api/prompts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: doc.pending.content,
          version: doc.pending.version,
          activate: true,
        }),
      });
      if (!r.ok) throw new Error(`Server error ${r.status}`);
      const updated = (await fetch(`/api/prompts/${id}`).then((x) =>
        x.json()
      )) as DocumentRecord;
      dispatch({ type: "ACTIVATED", document: updated });
    } catch (err) {
      dispatch({
        type: "SAVE_ERROR",
        message: err instanceof Error ? err.message : "Activation failed",
      });
    }
  }, [state.documents]);

  const clearPending = useCallback(async (id: string) => {
    dispatch({ type: "CLEARING", id });
    try {
      await fetch(`/api/prompts/${id}`, { method: "DELETE" });
      dispatch({ type: "CLEARED", id });
    } catch (err) {
      dispatch({
        type: "SAVE_ERROR",
        message: err instanceof Error ? err.message : "Clear failed",
      });
    }
  }, []);

  if (state.loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <span className="text-xs font-mono text-zinc-500">loading documents...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {state.error && (
        <p className="text-xs font-mono text-red-400 mb-2">{state.error}</p>
      )}

      {state.documents.map((doc) => {
        const isExpanded = state.expandedId === doc.id;
        const isEditing = state.editingId === doc.id;
        const isSaving = state.saving[doc.id];

        return (
          <div key={doc.id} className="border border-zinc-700/60 rounded">
            {/* Header */}
            <button
              onClick={() => dispatch({ type: "TOGGLE_EXPAND", id: doc.id })}
              className="w-full flex items-start justify-between px-4 py-3 text-left hover:bg-zinc-800/40 transition-colors rounded"
            >
              <div>
                <p className="text-sm font-mono text-zinc-200">{doc.name}</p>
                <p className="text-[11px] font-mono text-zinc-500 mt-0.5">{doc.description}</p>
              </div>
              <div className="flex items-center gap-3 ml-4 shrink-0">
                {doc.pending && (
                  <span className="text-[10px] font-mono text-amber-400 uppercase tracking-widest">
                    update queued
                  </span>
                )}
                <span className="text-[10px] font-mono text-zinc-600">v{doc.version}</span>
                <span className="text-zinc-600 text-xs">{isExpanded ? "▲" : "▼"}</span>
              </div>
            </button>

            {/* Expanded content */}
            {isExpanded && (
              <div className="border-t border-zinc-700/60 px-4 py-3 space-y-3">
                {/* Pending version notice */}
                {doc.pending && (
                  <div className="bg-amber-950/30 border border-amber-700/40 rounded p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-mono text-amber-400 uppercase tracking-widest">
                        pending v{doc.pending.version}
                      </span>
                      <span className="text-[10px] font-mono text-zinc-600">
                        queued {new Date(doc.pending.queuedAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-[11px] font-mono text-zinc-400 mb-2">
                      Activates on next session completion (C12). Use "Activate now" to force.
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => void activatePending(doc.id)}
                        disabled={isSaving}
                        className="text-[11px] font-mono text-emerald-400 hover:text-emerald-300 disabled:opacity-50 transition-colors"
                      >
                        Activate now
                      </button>
                      <span className="text-zinc-700">·</span>
                      <button
                        onClick={() => void clearPending(doc.id)}
                        disabled={isSaving}
                        className="text-[11px] font-mono text-zinc-500 hover:text-zinc-400 disabled:opacity-50 transition-colors"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                )}

                {/* Current active content */}
                {!isEditing && (
                  <>
                    <div>
                      <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest mb-1">
                        active — v{doc.version}
                      </p>
                      <pre className="text-[11px] font-mono text-zinc-400 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto bg-zinc-900/60 border border-zinc-700/40 rounded p-3">
                        {doc.content}
                      </pre>
                    </div>
                    <button
                      onClick={() =>
                        dispatch({
                          type: "START_EDIT",
                          id: doc.id,
                          currentContent: doc.content,
                          currentVersion: doc.version,
                        })
                      }
                      className="text-[11px] font-mono text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                      Edit →
                    </button>
                  </>
                )}

                {/* Edit form */}
                {isEditing && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest">
                      new version
                    </p>
                    <textarea
                      value={state.editContent}
                      onChange={(e) =>
                        dispatch({ type: "SET_CONTENT", content: e.target.value })
                      }
                      className="w-full h-72 text-[11px] font-mono text-zinc-200 bg-zinc-900 border border-zinc-600 rounded p-3 resize-y focus:outline-none focus:border-zinc-400"
                      spellCheck={false}
                    />
                    <div className="flex items-center gap-3">
                      <label className="text-[11px] font-mono text-zinc-500">version</label>
                      <input
                        type="number"
                        value={state.editVersion}
                        onChange={(e) =>
                          dispatch({ type: "SET_VERSION", version: e.target.value })
                        }
                        className="w-16 text-[11px] font-mono text-zinc-200 bg-zinc-900 border border-zinc-600 rounded px-2 py-1 focus:outline-none focus:border-zinc-400"
                      />
                    </div>
                    <div className="flex items-center gap-4">
                      <button
                        onClick={() => void queueUpdate(doc.id, false)}
                        disabled={isSaving}
                        className="text-[11px] font-mono text-zinc-300 hover:text-white disabled:opacity-50 transition-colors border border-zinc-600 hover:border-zinc-400 rounded px-3 py-1"
                      >
                        Queue for next session
                      </button>
                      <button
                        onClick={() => void queueUpdate(doc.id, true)}
                        disabled={isSaving}
                        className="text-[11px] font-mono text-emerald-400 hover:text-emerald-300 disabled:opacity-50 transition-colors"
                      >
                        Activate now
                      </button>
                      <button
                        onClick={() => dispatch({ type: "CANCEL_EDIT" })}
                        className="text-[11px] font-mono text-zinc-600 hover:text-zinc-400 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
