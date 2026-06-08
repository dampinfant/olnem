"use client";

// C15 — Audit panel for the operator interface.
//
// Shows audit log entries from /api/audit with category filtering and refresh.

import { useCallback, useEffect, useReducer } from "react";
import type { AuditLogEntry, AuditEventCategory } from "@/lib/audit/types";

// ─── State ────────────────────────────────────────────────────────────────────

type CategoryFilter = AuditEventCategory | "all";

interface PanelState {
  entries: AuditLogEntry[];
  total: number;
  loading: boolean;
  error: string | null;
  category: CategoryFilter;
}

type PanelAction =
  | { type: "LOADING" }
  | { type: "LOADED"; entries: AuditLogEntry[]; total: number }
  | { type: "ERROR"; message: string }
  | { type: "SET_CATEGORY"; category: CategoryFilter };

function reducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "LOADING":
      return { ...state, loading: true, error: null };
    case "LOADED":
      return { ...state, loading: false, entries: action.entries, total: action.total };
    case "ERROR":
      return { ...state, loading: false, error: action.message };
    case "SET_CATEGORY":
      return { ...state, category: action.category };
  }
}

const initial: PanelState = {
  entries: [],
  total: 0,
  loading: false,
  error: null,
  category: "all",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function AuditPanel() {
  const [state, dispatch] = useReducer(reducer, initial);

  const load = useCallback(async (category: CategoryFilter) => {
    dispatch({ type: "LOADING" });
    try {
      const url = category === "all"
        ? "/api/audit?limit=200"
        : `/api/audit?category=${category}&limit=200`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as { entries: AuditLogEntry[]; total: number };
      dispatch({ type: "LOADED", entries: data.entries, total: data.total });
    } catch (err) {
      dispatch({ type: "ERROR", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    load(state.category);
  }, [state.category, load]);

  const handleCategoryChange = (category: CategoryFilter) => {
    dispatch({ type: "SET_CATEGORY", category });
  };

  return (
    <div className="audit-panel">
      <div className="audit-panel-header">
        <span className="audit-panel-title">Audit Log</span>
        <span className="audit-panel-count">{state.total} total</span>
        <button
          className="audit-refresh-btn"
          onClick={() => load(state.category)}
          disabled={state.loading}
        >
          {state.loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="audit-filters">
        {(["all", "session_lifecycle", "pipeline_error", "operator_action"] as CategoryFilter[]).map((cat) => (
          <button
            key={cat}
            className={`audit-filter-btn${state.category === cat ? " active" : ""}`}
            onClick={() => handleCategoryChange(cat)}
          >
            {cat === "all" ? "All" : cat.replace("_", " ")}
          </button>
        ))}
      </div>

      {state.error && (
        <div className="audit-error">{state.error}</div>
      )}

      {state.entries.length === 0 && !state.loading && !state.error && (
        <div className="audit-empty">No entries.</div>
      )}

      <ul className="audit-entry-list">
        {state.entries.map((entry) => (
          <AuditEntryRow key={entry.entryId} entry={entry} />
        ))}
      </ul>
    </div>
  );
}

// ─── Entry row ────────────────────────────────────────────────────────────────

function AuditEntryRow({ entry }: { entry: AuditLogEntry }) {
  const ev = entry.event;
  const ts = "timestamp" in ev ? new Date(ev.timestamp).toLocaleTimeString() : "";

  const label = (() => {
    if (ev.category === "session_lifecycle") return ev.type;
    if (ev.category === "pipeline_error") return "pipeline_error";
    if (ev.category === "operator_action") return ev.type;
    return "unknown";
  })();

  const detail = (() => {
    if (ev.category === "session_lifecycle" && ev.type === "session_init") {
      return `session ${ev.sessionId.slice(0, 8)} — idea ${ev.ideaLength} chars`;
    }
    if (ev.category === "session_lifecycle" && ev.type === "session_close") {
      return `session ${ev.sessionId.slice(0, 8)} — ${ev.terminalStatus}${ev.outputMode ? ` / ${ev.outputMode}` : ""}`;
    }
    if (ev.category === "pipeline_error") {
      return `session ${ev.sessionId.slice(0, 8)} — ${ev.message}`;
    }
    if (ev.category === "operator_action") {
      const parts: string[] = [];
      if (ev.sessionId) parts.push(`session ${ev.sessionId.slice(0, 8)}`);
      if (ev.documentId) parts.push(`doc ${ev.documentId}`);
      if (ev.version != null) parts.push(`v${ev.version}`);
      return parts.join(" — ");
    }
    return "";
  })();

  return (
    <li className={`audit-entry audit-entry--${ev.category}`}>
      <span className="audit-entry-time">{ts}</span>
      <span className="audit-entry-label">{label}</span>
      {detail && <span className="audit-entry-detail">{detail}</span>}
    </li>
  );
}
