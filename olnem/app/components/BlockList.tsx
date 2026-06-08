"use client";

// Pure rendering component for evaluation stream blocks.
// Used by both ReasoningDisplay (self-managed) and the operator page (hook-managed).

import type { Block } from "@/app/types/evaluation";
import type { AgentRole } from "@/lib/documents/types";
import { ExplainButton } from "@/app/components/ExplainButton";

// ─── Agent label ──────────────────────────────────────────────────────────────

const AGENT_LABELS: Record<AgentRole, string> = {
  main_agent: "evaluation",
  verification_agent: "verification",
  explanation_agent: "explanation",
};

const AGENT_COLORS: Record<AgentRole, string> = {
  main_agent: "text-zinc-400",
  verification_agent: "text-blue-400",
  explanation_agent: "text-violet-400",
};

function AgentLabel({ agent }: { agent: AgentRole }) {
  return (
    <span className={`text-[10px] font-mono uppercase tracking-widest ${AGENT_COLORS[agent]}`}>
      {AGENT_LABELS[agent]}
    </span>
  );
}

// ─── Block sub-components ─────────────────────────────────────────────────────

function ReasoningBlock({ block }: { block: Extract<Block, { kind: "reasoning" }> }) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-1">
        <AgentLabel agent={block.sourceAgent} />
        {block.componentId && (
          <span className="text-[10px] font-mono text-zinc-600">{block.componentId}</span>
        )}
      </div>
      <p className="text-sm text-zinc-200 font-mono whitespace-pre-wrap leading-relaxed">
        {block.text}
      </p>
      {block.text.trim() && (
        <div className="mt-2">
          <ExplainButton targetType="component" text={block.text} />
        </div>
      )}
    </div>
  );
}

const CLASSIFICATION_COLORS: Record<string, string> = {
  frontier: "border-amber-500/60 text-amber-400",
  design: "border-sky-500/60 text-sky-400",
  resolved: "border-emerald-500/60 text-emerald-400",
  interrupted: "border-zinc-600 text-zinc-500",
};

function ClassifiedBlock({ block }: { block: Extract<Block, { kind: "classified" }> }) {
  const color = CLASSIFICATION_COLORS[block.classification] ?? "border-zinc-600 text-zinc-400";
  const explainText =
    `Component: ${block.componentId}\n` +
    `Classification: ${block.classification}` +
    (block.ground ? `\nGround: ${block.ground.replace("_", " ")}` : "");
  return (
    <div className={`mb-2 pl-3 border-l-2 ${color}`}>
      <span className="text-xs font-mono">
        {block.componentId}
        {" → "}
        <span className="uppercase">{block.classification}</span>
        {block.ground && (
          <span className="text-zinc-600"> ({block.ground.replace("_", " ")})</span>
        )}
      </span>
      <div className="mt-1">
        <ExplainButton targetType="decision" text={explainText} />
      </div>
    </div>
  );
}

function VerifyingBlock({ block }: { block: Extract<Block, { kind: "verifying" }> }) {
  return (
    <div className="mb-2 pl-3 border-l-2 border-zinc-700 flex items-center gap-2">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500/60 animate-pulse" />
      <span className="text-[11px] font-mono text-zinc-600">
        {block.componentId} — verifying
      </span>
    </div>
  );
}

function VerifiedBlock({ block }: { block: Extract<Block, { kind: "verified" }> }) {
  const confirmed = block.result === "confirmed";
  const borderColor = confirmed ? "border-emerald-600/60" : "border-amber-500/60";
  const explainText =
    `Verification of component: ${block.componentId}\n` +
    `Result: ${block.result}` +
    (block.refinedClassification ? `\nRefined classification: ${block.refinedClassification}` : "") +
    (block.ground ? `\nGround: ${block.ground}` : "") +
    (block.flagCount > 0 ? `\nFlags raised: ${block.flagCount}` : "");
  return (
    <div className={`mb-5 pl-3 border-l-2 ${borderColor}`}>
      <div className="flex items-center gap-2 mb-1">
        <AgentLabel agent="verification_agent" />
        <span className="text-[10px] font-mono text-zinc-600">{block.componentId}</span>
      </div>
      <p className="text-xs font-mono text-zinc-300">
        {confirmed ? "confirmed" : "disputed"}
        {block.refinedClassification && (
          <span className="ml-2 text-amber-400">→ {block.refinedClassification}</span>
        )}
        {block.flagCount > 0 && (
          <span className="ml-2 text-zinc-500">
            {block.flagCount} flag{block.flagCount !== 1 ? "s" : ""}
          </span>
        )}
      </p>
      {block.ground && (
        <p className="text-xs text-zinc-500 font-mono mt-0.5">{block.ground}</p>
      )}
      <div className="mt-1">
        <ExplainButton targetType="decision" text={explainText} />
      </div>
    </div>
  );
}

const MODE_LABELS: Record<string, string> = {
  mode_one: "Mode One — Frontier located",
  mode_two: "Mode Two — Validated and actionable",
  mode_three: "Mode Three — Partially validated",
};

function ModeBlock({ block }: { block: Extract<Block, { kind: "mode" }> }) {
  const explainText =
    `Output mode: ${block.mode}` +
    (block.subtype ? `\nSubtype: ${block.subtype.replace("_", " ")}` : "");
  return (
    <div className="mb-5 py-2 px-3 bg-zinc-900 border border-zinc-700/60 rounded">
      <p className="text-sm font-mono text-zinc-200">
        {MODE_LABELS[block.mode] ?? block.mode}
      </p>
      {block.subtype && (
        <p className="text-[11px] font-mono text-zinc-500 mt-0.5">
          {block.subtype.replace("_", " ")}
        </p>
      )}
      <div className="mt-2">
        <ExplainButton targetType="output" text={explainText} />
      </div>
    </div>
  );
}

function ErrorBlock({ block }: { block: Extract<Block, { kind: "error" }> }) {
  return (
    <div className="mb-5 pl-3 border-l-2 border-red-700/60">
      <p className="text-xs font-mono text-red-400">
        {block.recoverable ? "transient error" : "error"}
        {": "}
        {block.message}
      </p>
    </div>
  );
}

const QUESTION_TYPE_LABELS: Record<string, string> = {
  step0_quality: "step 0 — input quality gate",
  step0_framing: "step 0 — framing orientation",
  design_fork: "design fork",
};

function QuestionBlock({ block }: { block: Extract<Block, { kind: "question" }> }) {
  return (
    <div className="mb-5 pl-3 border-l-2 border-amber-700/50">
      <p className="text-[10px] font-mono text-amber-500/70 uppercase tracking-widest mb-1">
        {QUESTION_TYPE_LABELS[block.questionType] ?? block.questionType}
      </p>
      <p className="text-sm font-mono text-zinc-300">{block.question}</p>
    </div>
  );
}

// ─── BlockList ────────────────────────────────────────────────────────────────

export function BlockList({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block) => {
        switch (block.kind) {
          case "reasoning":
            return <ReasoningBlock key={block.id} block={block} />;
          case "classified":
            return <ClassifiedBlock key={block.id} block={block} />;
          case "verifying":
            return <VerifyingBlock key={block.id} block={block} />;
          case "verified":
            return <VerifiedBlock key={block.id} block={block} />;
          case "mode":
            return <ModeBlock key={block.id} block={block} />;
          case "error":
            return <ErrorBlock key={block.id} block={block} />;
          case "question":
            return <QuestionBlock key={block.id} block={block} />;
        }
      })}
    </>
  );
}
