"use client";

import type {
  SessionState,
  ComponentState,
  FrontierQuestion,
  WhatHoldsEntry,
} from "@/lib/session/schema";

// ─── Action required derivation ───────────────────────────────────────────────
//
// Each dark (frontier) node requires one of three things to unblock:
//   experiment — the gap is named and an experiment to close it is definable
//   expert     — the question is named but requires domain input to answer
//   reframe    — the problem framing itself needs a user-contributed conceptual shift
//
// Derivation:
//   modeThreeSubtype = "known_unknown"     → experiment (gap is definable)
//   modeThreeSubtype = "unknown_unknown"   → expert (gap is named, not yet testable)
//   frontier with openTradeoff (no subtype)→ experiment (requires external data)
//   frontier with no tradeoff (pure gap)   → expert (domain question)

type ActionKind = "experiment" | "expert" | "reframe";

interface ActionRequired {
  kind: ActionKind;
  label: string;
  description: string;
}

const ACTION_CONFIGS: Record<ActionKind, { label: string; color: string }> = {
  experiment: { label: "(a) Specific experiment", color: "text-amber-400 border-amber-700/60" },
  expert:     { label: "(b) Domain expert",       color: "text-sky-400 border-sky-700/60" },
  reframe:    { label: "(c) Conceptual reframe",  color: "text-violet-400 border-violet-700/60" },
};

function deriveAction(
  fq: FrontierQuestion,
  comp: ComponentState | undefined
): ActionRequired {
  if (fq.modeThreeSubtype === "known_unknown") {
    return {
      kind: "experiment",
      label: ACTION_CONFIGS.experiment.label,
      description: "An experiment to close this gap is definable. Name the test.",
    };
  }
  if (fq.modeThreeSubtype === "unknown_unknown") {
    return {
      kind: "expert",
      label: ACTION_CONFIGS.expert.label,
      description: "The gap is named but not yet experimentally specifiable. Consult a domain expert with the question below.",
    };
  }
  if (comp?.openTradeoff && !comp.openTradeoff.resolvableByReasoning) {
    return {
      kind: "experiment",
      label: ACTION_CONFIGS.experiment.label,
      description: "The open tradeoff requires external data or a designed test to close.",
    };
  }
  return {
    kind: "expert",
    label: ACTION_CONFIGS.expert.label,
    description: "A domain expert is required to answer this question. The question is named below.",
  };
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-2">
      {children}
    </p>
  );
}

function WhatHoldsTable({ entries }: { entries: WhatHoldsEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <div className="space-y-2">
      {entries.map((e) => (
        <div key={e.componentId} className="pl-3 border-l-2 border-emerald-800/60">
          <p className="text-xs font-mono text-emerald-300">{e.componentText || e.componentId}</p>
          <p className="text-[11px] font-mono text-zinc-400 mt-0.5">{e.summary}</p>
          <p className="text-[9px] font-mono text-zinc-600 mt-0.5">
            {e.resolutionGround === "precedent" ? "ground: precedent" : "ground: logical coherence"}
          </p>
        </div>
      ))}
    </div>
  );
}

function BlockingNode({
  fq,
  comp,
}: {
  fq: FrontierQuestion;
  comp: ComponentState | undefined;
}) {
  const action = deriveAction(fq, comp);
  const actionConfig = ACTION_CONFIGS[action.kind];

  return (
    <div className="border border-zinc-800 rounded-lg p-4 bg-zinc-900/50">
      <div className="flex items-start justify-between gap-4 mb-3">
        <p className="text-xs font-mono text-amber-300 font-medium">
          {fq.label || `Frontier ${fq.index + 1}`}
        </p>
        <span
          className={`text-[10px] font-mono border rounded px-2 py-0.5 whitespace-nowrap ${actionConfig.color}`}
        >
          {action.label}
        </span>
      </div>
      <p className="text-sm font-mono text-zinc-200 leading-relaxed mb-2">
        {fq.question}
      </p>
      <p className="text-[11px] font-mono text-zinc-500">{action.description}</p>
    </div>
  );
}

// ─── Mode two: all resolved ───────────────────────────────────────────────────

function ModeTwoConclusion({ session }: { session: SessionState }) {
  const out = session.finalOutput!;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="py-4 px-5 bg-emerald-950/40 border border-emerald-800/50 rounded-lg">
        <p className="text-lg font-mono text-emerald-300 font-medium">
          Problem is solved.
        </p>
        {out.structuralSoundnessStatement && (
          <p className="text-sm font-mono text-emerald-400/80 mt-1.5 leading-relaxed">
            {out.structuralSoundnessStatement}
          </p>
        )}
      </div>

      {/* What holds — full validation log */}
      <div>
        <SectionLabel>Validation log — what holds</SectionLabel>
        <WhatHoldsTable entries={out.whatHolds} />
      </div>

      {/* What already happened */}
      {out.whatAlreadyHappened && (
        <div>
          <SectionLabel>What has already happened</SectionLabel>
          <p className="text-sm font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap">
            {out.whatAlreadyHappened}
          </p>
        </div>
      )}

      {/* What is novel */}
      {out.whatIsNovel && (
        <div>
          <SectionLabel>What is genuinely novel</SectionLabel>
          <p className="text-sm font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap">
            {out.whatIsNovel}
          </p>
        </div>
      )}

      {/* Implementation path */}
      {out.implementationPath && (
        <div>
          <SectionLabel>Implementation path</SectionLabel>
          <p className="text-sm font-mono text-zinc-200 leading-relaxed whitespace-pre-wrap">
            {out.implementationPath}
          </p>
        </div>
      )}

      {/* Lossy decomposition qualifier */}
      {out.lossyDecomposition && (
        <div className="pl-3 border-l-2 border-amber-700/60">
          <SectionLabel>Lossy decomposition</SectionLabel>
          <p className="text-xs font-mono text-amber-300">{out.lossyDecomposition.note}</p>
          <p className="text-[11px] font-mono text-zinc-500 mt-1">
            Covers: {out.lossyDecomposition.covers}
          </p>
          <p className="text-[11px] font-mono text-zinc-500">
            Does not cover: {out.lossyDecomposition.doesNotCover}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Mode one / three: unresolved ────────────────────────────────────────────

function ModeOneThreeConclusion({ session }: { session: SessionState }) {
  const out = session.finalOutput!;
  const components = session.decomposition.components;

  // Map component ID → ComponentState for quick lookup.
  const compById = new Map(components.map((c) => [c.id, c]));

  // Frontier questions in dependency order.
  // Components are already ordered by evaluation index, and prerequisites
  // are always evaluated before dependents (lower index = earlier evaluation).
  // The frontier questions in finalOutput mirror this order.
  const frontierQuestions = (out.frontierQuestions ?? []).filter((fq) => fq.isGenuineFrontier);

  // Match each frontier question to the blocking component.
  // The question label matches the component id or text prefix.
  const blockingComponents = frontierQuestions.map((fq) => {
    const comp = components.find(
      (c) =>
        c.classification === "frontier" &&
        (c.id === fq.label || c.text?.startsWith(fq.label.slice(0, 12)))
    );
    return { fq, comp };
  });

  const modeLabel =
    session.outputMode === "mode_one"
      ? "Mode one — Frontier located"
      : "Mode three — Partially validated";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="py-4 px-5 bg-zinc-900 border border-zinc-700/60 rounded-lg">
        <p className="text-sm font-mono text-zinc-300 font-medium">{modeLabel}</p>
        {out.whatRequiresExternalInput && (
          <p className="text-xs font-mono text-zinc-500 mt-1.5 leading-relaxed">
            {out.whatRequiresExternalInput}
          </p>
        )}
        {out.whatResolvesIfGapCloses && (
          <p className="text-xs font-mono text-zinc-400 mt-1.5 leading-relaxed">
            What resolves if the gap closes: {out.whatResolvesIfGapCloses}
          </p>
        )}
      </div>

      {/* Blocking nodes — in dependency order */}
      {blockingComponents.length > 0 && (
        <div>
          <SectionLabel>
            Blocking frontier{blockingComponents.length !== 1 ? "s" : ""} — dependency order
          </SectionLabel>
          <div className="space-y-3">
            {blockingComponents.map(({ fq, comp }, i) => (
              <BlockingNode key={i} fq={fq} comp={comp} />
            ))}
          </div>
        </div>
      )}

      {/* What holds — the resolved portion */}
      {out.whatHolds.length > 0 && (
        <div>
          <SectionLabel>What holds</SectionLabel>
          <WhatHoldsTable entries={out.whatHolds} />
        </div>
      )}

      {/* What already happened */}
      {out.whatAlreadyHappened && (
        <div>
          <SectionLabel>What has already happened</SectionLabel>
          <p className="text-sm font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap">
            {out.whatAlreadyHappened}
          </p>
        </div>
      )}

      {/* What is novel */}
      {out.whatIsNovel && (
        <div>
          <SectionLabel>What is genuinely novel</SectionLabel>
          <p className="text-sm font-mono text-zinc-300 leading-relaxed whitespace-pre-wrap">
            {out.whatIsNovel}
          </p>
        </div>
      )}

      {/* Lossy decomposition qualifier */}
      {out.lossyDecomposition && (
        <div className="pl-3 border-l-2 border-amber-700/60">
          <SectionLabel>Lossy decomposition</SectionLabel>
          <p className="text-xs font-mono text-amber-300">{out.lossyDecomposition.note}</p>
          <p className="text-[11px] font-mono text-zinc-500 mt-1">
            Covers: {out.lossyDecomposition.covers}
          </p>
          <p className="text-[11px] font-mono text-zinc-500">
            Does not cover: {out.lossyDecomposition.doesNotCover}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── ConclusionLayer ──────────────────────────────────────────────────────────

export function ConclusionLayer({ session }: { session: SessionState }) {
  if (!session.finalOutput) {
    return (
      <div className="py-4">
        <p className="text-xs font-mono text-zinc-600">
          Evaluation did not produce a final output.
        </p>
      </div>
    );
  }

  return session.outputMode === "mode_two" ? (
    <ModeTwoConclusion session={session} />
  ) : (
    <ModeOneThreeConclusion session={session} />
  );
}
