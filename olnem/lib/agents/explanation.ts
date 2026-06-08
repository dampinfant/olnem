// C16 — Explanation agent.
//
// ISOLATION INVARIANTS — enforced at the instantiation level, not by convention:
//
//   1. Separate Anthropic client instantiation.
//      This file creates its own `new Anthropic()`. It does not receive, share,
//      or reuse any client instance from the main agent or verification agent.
//
//   2. No session context.
//      ExplainInput has exactly two fields: targetType and text.
//      No session ID, no idea submission, no component history, no output mode.
//      The caller passes the text to explain explicitly — there is no lookup.
//
//   3. No shared state imports.
//      This file does not import from lib/session/, lib/orchestration/, or
//      lib/audit/. The only runtime imports are the Anthropic SDK, the prompt
//      constant, and the document registry (for prompt versioning — not session
//      state).
//
// The explanation agent's only job is plain-language translation of a named
// output, component, or decision. It does not evaluate, classify, or produce
// any result that influences the session.

import Anthropic from "@anthropic-ai/sdk";
import { EXPLANATION_AGENT_SYSTEM_PROMPT } from "@/lib/prompts";
import { getActiveContent } from "@/lib/documents/registry";

const EXPLANATION_MODEL = "claude-haiku-4-5-20251001";
const EXPLANATION_MAX_TOKENS = 512;

// ─── Input contract ───────────────────────────────────────────────────────────
//
// Two fields only. targetType labels what kind of thing is being explained.
// text is the verbatim content to explain — passed explicitly by the caller,
// never looked up from session state.

export type ExplainTargetType = "component" | "output" | "decision";

export interface ExplainInput {
  targetType: ExplainTargetType;
  text: string;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class ExplanationAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplanationAgentError";
  }
}

// ─── Agent caller ─────────────────────────────────────────────────────────────

export async function callExplanationAgent(
  input: ExplainInput,
  signal?: AbortSignal
): Promise<string> {
  // Separate instantiation. Not shared with main agent or verification agent.
  const client = new Anthropic();

  const userMessage = `Target type: ${input.targetType}\n\n${input.text}`;

  const response = await client.messages.create(
    {
      model: EXPLANATION_MODEL,
      max_tokens: EXPLANATION_MAX_TOKENS,
      system: getActiveContent("explanation_agent") ?? EXPLANATION_AGENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
      // No tools. Plain text output only.
    },
    { signal }
  );

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new ExplanationAgentError(
      `Explanation agent returned no text. Stop reason: ${response.stop_reason}`
    );
  }

  return textBlock.text;
}
