"use client";

import type { ComponentState, LayerId, SessionState } from "@/lib/session/schema";

// ─── Layout constants ─────────────────────────────────────────────────────────

const NODE_W = 180;
const NODE_H = 62;
const NODE_GAP = 18;
const LAYER_GAP = 96;
const PAD_X = 36;
const PAD_Y = 52;
const LABEL_H = 20;

// ─── Layer ordering ───────────────────────────────────────────────────────────

const LAYER_ORDER: LayerId[] = [
  "fundamental_coherence",
  "empirical_precedent",
  "structural_viability",
  "implementation_gap",
  "abstract",
];

const LAYER_LABELS: Record<LayerId, string> = {
  fundamental_coherence: "Fundamental",
  empirical_precedent: "Empirical",
  structural_viability: "Structural",
  implementation_gap: "Impl. Gap",
  abstract: "Abstract",
};

// ─── Node color scheme ────────────────────────────────────────────────────────
//
// resolved/precedent      — green   (strongest ground)
// resolved/logical_coherence — cyan (weaker ground)
// design                  — sky blue
// frontier                — amber/dark (unresolved, blocking)
// interrupted/pending     — zinc (inactive)

interface NodeColors {
  fill: string;
  stroke: string;
  textFill: string;
  groundFill: string;
}

function nodeColors(comp: ComponentState): NodeColors {
  if (comp.classification === "frontier") {
    return { fill: "#18181b", stroke: "#92400e", textFill: "#fbbf24", groundFill: "#b45309" };
  }
  if (comp.classification === "resolved") {
    return comp.resolutionGround === "precedent"
      ? { fill: "#052e16", stroke: "#16a34a", textFill: "#86efac", groundFill: "#4ade80" }
      : { fill: "#042f2e", stroke: "#0e7490", textFill: "#67e8f9", groundFill: "#22d3ee" };
  }
  if (comp.classification === "design") {
    return { fill: "#0c1a2e", stroke: "#1d4ed8", textFill: "#93c5fd", groundFill: "#60a5fa" };
  }
  return { fill: "#18181b", stroke: "#3f3f46", textFill: "#71717a", groundFill: "#52525b" };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function groundLabel(comp: ComponentState): string {
  const parts: string[] = [];
  if (comp.resolutionGround === "precedent") parts.push("precedent");
  else if (comp.resolutionGround === "logical_coherence") parts.push("logic");
  else if (comp.classification) parts.push(comp.classification);
  if (comp.isContingentPrerequisite) parts.push("prerequisite");
  if (comp.isDesignFork) parts.push("fork");
  return parts.join(" · ");
}

// ─── Edge path ────────────────────────────────────────────────────────────────

function bezierPath(
  x1: number, y1: number,
  x2: number, y2: number
): string {
  const dx = Math.abs(x2 - x1);
  const cx = dx * 0.45;
  return `M ${x1} ${y1} C ${x1 + cx} ${y1}, ${x2 - cx} ${y2}, ${x2} ${y2}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ValidationGraph({ session }: { session: SessionState }) {
  const components = session.decomposition.components;

  if (components.length === 0) {
    return <p className="text-xs font-mono text-zinc-600 py-4">No components to display.</p>;
  }

  // Build the active layer list — only layers that have components, in canonical order.
  const activeLayers = LAYER_ORDER.filter((lid) =>
    components.some((c) => c.layerId === lid)
  );
  // Append any non-canonical layerIds so nothing is lost.
  const extraLayers = [
    ...new Set(
      components
        .filter((c) => !LAYER_ORDER.includes(c.layerId))
        .map((c) => c.layerId)
    ),
  ] as LayerId[];
  const layers: LayerId[] = [...activeLayers, ...extraLayers];

  const byLayer = new Map<LayerId, ComponentState[]>(
    layers.map((lid) => [
      lid,
      components
        .filter((c) => c.layerId === lid)
        .sort((a, b) => a.index - b.index),
    ])
  );

  const nLayers = layers.length;
  const maxNodes = Math.max(...layers.map((lid) => byLayer.get(lid)!.length));
  const totalNodeH = maxNodes * NODE_H + Math.max(0, maxNodes - 1) * NODE_GAP;
  const svgW = PAD_X * 2 + nLayers * NODE_W + (nLayers - 1) * LAYER_GAP;
  const svgH = PAD_Y * 2 + LABEL_H + totalNodeH;

  // Compute node positions.
  const pos = new Map<string, { x: number; y: number }>();
  const nodeList: Array<{ x: number; y: number; comp: ComponentState }> = [];

  layers.forEach((lid, li) => {
    const nodes = byLayer.get(lid)!;
    const colH = nodes.length * NODE_H + Math.max(0, nodes.length - 1) * NODE_GAP;
    const colStartY = PAD_Y + LABEL_H + (totalNodeH - colH) / 2;
    const colX = PAD_X + li * (NODE_W + LAYER_GAP);

    nodes.forEach((comp, ri) => {
      const x = colX;
      const y = colStartY + ri * (NODE_H + NODE_GAP);
      pos.set(comp.id, { x, y });
      nodeList.push({ x, y, comp });
    });
  });

  // Build edge list.
  type EdgeKind = "prerequisite" | "fork_active" | "fork_inactive";
  const edges: Array<{ from: string; to: string; kind: EdgeKind }> = [];

  for (const comp of components) {
    // Contingent prerequisite: this component IS the prerequisite for others.
    for (const depId of comp.prerequisiteFor) {
      if (pos.has(depId)) {
        edges.push({ from: comp.id, to: depId, kind: "prerequisite" });
      }
    }
    // Design fork paths.
    if (comp.isDesignFork && comp.designForkPaths) {
      comp.designForkPaths.forEach((path, pi) => {
        const active = comp.activeDesignForkPathIndex === pi;
        for (const affId of path.affectedComponentIds) {
          if (pos.has(affId)) {
            edges.push({ from: comp.id, to: affId, kind: active ? "fork_active" : "fork_inactive" });
          }
        }
      });
    }
  }

  const EDGE_STYLES: Record<EdgeKind, { stroke: string; strokeWidth: number; dash?: string; opacity: number; markerId: string }> = {
    prerequisite:  { stroke: "#7c3aed", strokeWidth: 1.5, opacity: 0.75, markerId: "arr-pre" },
    fork_active:   { stroke: "#0ea5e9", strokeWidth: 2,   opacity: 0.9,  markerId: "arr-fa" },
    fork_inactive: { stroke: "#3f3f46", strokeWidth: 1,   dash: "4 3", opacity: 0.45, markerId: "arr-fi" },
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800/60 bg-zinc-950">
      <svg
        width={svgW}
        height={svgH}
        viewBox={`0 0 ${svgW} ${svgH}`}
        style={{ fontFamily: "monospace" }}
      >
        <defs>
          {(["pre", "fa", "fi"] as const).map((key) => {
            const fill = key === "pre" ? "#7c3aed" : key === "fa" ? "#0ea5e9" : "#3f3f46";
            return (
              <marker
                key={key}
                id={`arr-${key}`}
                markerWidth="7"
                markerHeight="7"
                refX="5"
                refY="2.5"
                orient="auto"
              >
                <path d="M0,0 L0,5 L7,2.5 z" fill={fill} />
              </marker>
            );
          })}
        </defs>

        {/* Layer column labels */}
        {layers.map((lid, li) => (
          <text
            key={lid}
            x={PAD_X + li * (NODE_W + LAYER_GAP) + NODE_W / 2}
            y={PAD_Y + LABEL_H - 4}
            textAnchor="middle"
            fill="#52525b"
            fontSize={9}
          >
            {LAYER_LABELS[lid] ?? lid}
          </text>
        ))}

        {/* Edges (rendered under nodes) */}
        {edges.map((edge, i) => {
          const s = pos.get(edge.from);
          const t = pos.get(edge.to);
          if (!s || !t) return null;
          const style = EDGE_STYLES[edge.kind];
          const d = bezierPath(
            s.x + NODE_W, s.y + NODE_H / 2,
            t.x, t.y + NODE_H / 2
          );
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={style.stroke}
              strokeWidth={style.strokeWidth}
              strokeDasharray={style.dash}
              opacity={style.opacity}
              markerEnd={`url(#${style.markerId})`}
            />
          );
        })}

        {/* Nodes */}
        {nodeList.map(({ x, y, comp }) => {
          const c = nodeColors(comp);
          const label = trunc(comp.text || comp.id, 20);
          const sub = groundLabel(comp);
          return (
            <g key={comp.id}>
              <title>{`${comp.id}\n${comp.text}`}</title>
              <rect
                x={x} y={y}
                width={NODE_W} height={NODE_H}
                rx={4}
                fill={c.fill}
                stroke={c.stroke}
                strokeWidth={1.5}
              />
              <text x={x + 12} y={y + 24} fill={c.textFill} fontSize={11}>
                {label}
              </text>
              {sub && (
                <text x={x + 12} y={y + 42} fill={c.groundFill} fontSize={9} opacity={0.85}>
                  {sub}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 px-4 py-2 border-t border-zinc-800/60">
        {[
          { color: "#4ade80", label: "resolved · precedent" },
          { color: "#22d3ee", label: "resolved · logic" },
          { color: "#60a5fa", label: "design" },
          { color: "#fbbf24", label: "frontier" },
          { color: "#7c3aed", label: "→ prerequisite" },
          { color: "#0ea5e9", label: "→ fork (active)" },
        ].map(({ color, label }) => (
          <div key={label} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: color }}
            />
            <span className="text-[9px] font-mono text-zinc-600">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
