// C2 — Verification agent caller
//
// Context-blindness is enforced here — at the function signature and at the
// API call construction site. The ONLY data that enters the verification
// agent's context window is what is in VerificationAgentCallInput (3 fields).
//
// There is no other parameter. Adding session context here is the violation
// the architecture prevents. The TypeScript type makes that violation a
// compile error.

import Anthropic from "@anthropic-ai/sdk";
import type {
  VerificationAgentCallInput,
  VerificationReturnInput,
} from "@/lib/contracts/output";
import { VERIFICATION_AGENT_TOOL_ALLOWLIST } from "@/lib/contracts/output";
import { VERIFICATION_AGENT_SYSTEM_PROMPT } from "@/lib/prompts";
import { getActiveContent } from "@/lib/documents/registry";

const VERIFICATION_MODEL = "claude-sonnet-4-6";
const VERIFICATION_MAX_TOKENS = 2048;

export class VerificationAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationAgentError";
  }
}

// The function signature IS the enforcement.
// VerificationAgentCallInput has exactly 3 fields: component, classification, reasoning.
// Nothing from SessionState can enter this call.
//
// signal is an infrastructure concern (C14 abort propagation), not session context.
// It is a separate parameter and does not violate context-blindness.
export async function callVerificationAgent(
  input: VerificationAgentCallInput,
  signal?: AbortSignal
): Promise<VerificationReturnInput> {
  const client = new Anthropic();

  // The user message is constructed from the 3 fields only.
  // Format makes the structure legible to the verification agent.
  const userMessage =
    `Component:\n${input.component}\n\n` +
    `Classification: ${input.classification}\n\n` +
    `Reasoning:\n${input.reasoning}`;

  const response = await client.messages.create(
    {
      model: VERIFICATION_MODEL,
      max_tokens: VERIFICATION_MAX_TOKENS,
      system: getActiveContent("verification_agent") ?? VERIFICATION_AGENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
      // C13: explicit allowlist — only tools on this list reach the verification agent.
      // New system tools are unavailable here unless deliberately added to the allowlist.
      tools: VERIFICATION_AGENT_TOOL_ALLOWLIST,
      // Force the verification_return tool — the agent must call it.
      tool_choice: { type: "tool", name: "verification_return" },
    },
    // C14: pass abort signal for continuous in-flight stop detection.
    { signal }
  );

  const toolUse = response.content.find(
    (b) => b.type === "tool_use" && b.name === "verification_return"
  );

  if (!toolUse || toolUse.type !== "tool_use") {
    throw new VerificationAgentError(
      "Verification agent did not call verification_return. " +
        `Stop reason: ${response.stop_reason}. ` +
        `Content blocks: ${response.content.map((b) => b.type).join(", ")}`
    );
  }

  return toolUse.input as VerificationReturnInput;
}
