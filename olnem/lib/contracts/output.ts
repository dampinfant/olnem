// C10 — Structured output contract
//
// Three layers:
// 1. Tool definitions passed to the Claude API (main agent + verification agent)
// 2. Stream event types emitted from the orchestration route to the client
// 3. The verification agent call envelope — exactly 3 fields, no more
//
// THE DUAL-EMISSION INVARIANT:
// Every time the main agent classifies a component, it produces BOTH:
//   - Streaming text content (the NL reasoning, visible chain-of-thought)
//   - A tool_use block in the same API response (the structured fields)
// These arrive in the same Anthropic SDK streaming response.
// The orchestration layer MUST reject any classification event that has
// structured fields without reasoning text, or reasoning text without fields.

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type {
  ComponentClassification,
  ResolutionGround,
  SurfacedItemDisposition,
  OutputMode,
  ModeThreeSubtype,
  LayerId,
} from "@/lib/session/schema";
import type { AgentRole } from "@/lib/documents/types";

export type { AgentRole };

// ─── Layer 1: Tool definitions ───────────────────────────────────────────────
//
// Two tools exist in this system:
//   classify_component — used by the main agent to emit structured classification
//   verification_return — used by the verification agent to return its result
//
// Tool definitions are the source of truth for both the Claude API call and the
// TypeScript types derived below. If the schema changes here, the types change.

export const CLASSIFY_COMPONENT_TOOL: Tool = {
  name: "classify_component",
  description:
    "Emit a structured classification for the current component. " +
    "This tool is called alongside the reasoning text — never instead of it. " +
    "One call per classifiable event.",
  input_schema: {
    type: "object" as const,
    properties: {
      component_id: {
        type: "string",
        description: "The ID of the component being classified.",
      },
      step: {
        type: "string",
        enum: [
          "step_3_validation_loop",
          "step_4_verification_pass",
          "step_5_output_mode",
        ],
        description: "Which step of the protocol this emission corresponds to.",
      },

      // ── step_3_validation_loop fields ──
      classification: {
        type: "string",
        enum: ["frontier", "design", "resolved", "interrupted"],
        description: "Present on step_3_validation_loop.",
      },
      resolution_ground: {
        type: "string",
        enum: ["precedent", "logical_coherence"],
        description:
          "Present on step_3_validation_loop when classification = resolved or design.",
      },
      open_tradeoff: {
        type: "object",
        description:
          "Present when the component resolves on logical coherence with an open tradeoff. " +
          "If resolvable_by_reasoning = false, the component must be reclassified as frontier.",
        properties: {
          description: { type: "string" },
          resolvable_by_reasoning: { type: "boolean" },
        },
        required: ["description", "resolvable_by_reasoning"],
      },
      is_compound_tradeoff: {
        type: "boolean",
        description:
          "True when the open tradeoff contains both a design-resolvable sub-element " +
          "and a behavioral-data sub-element. When true, compound_parts must be present.",
      },
      compound_parts: {
        type: "array",
        description:
          "Present when is_compound_tradeoff = true. Each part carries its own " +
          "classification and will be passed to the verification agent separately.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: {
              type: "string",
              enum: ["design_resolvable", "behavioral_data"],
            },
            description: { type: "string" },
          },
          required: ["id", "type", "description"],
        },
      },
      surfaced_item_dispositions: {
        type: "array",
        description:
          "Dispositions for any items surfaced during validation loop search " +
          "that are not the component's resolution. Every surfaced item needs one.",
        items: {
          type: "object",
          properties: {
            item_id: { type: "string" },
            disposition: {
              type: "string",
              enum: ["dismissed", "deferred", "elevated"],
            },
            reason: { type: "string" },
            deferred_target: { type: "string" },
            elevated_component_id: { type: "string" },
          },
          required: ["item_id", "disposition", "reason"],
        },
      },

      // ── step_4_verification_pass fields ──
      verification_pass: {
        type: "object",
        description:
          "Present on step_4_verification_pass. These fields are extracted and " +
          "passed verbatim to the verification agent API call — no summarization.",
        properties: {
          verbatim_component: {
            type: "string",
            description: "The component text, not paraphrased.",
          },
          verbatim_reasoning: {
            type: "string",
            description: "The full reasoning from the NL stream, not paraphrased.",
          },
          classification: {
            type: "string",
            enum: ["frontier", "design", "resolved"],
          },
        },
        required: ["verbatim_component", "verbatim_reasoning", "classification"],
      },

      // ── step_5_output_mode fields ──
      output_mode: {
        type: "string",
        enum: ["mode_one", "mode_two", "mode_three"],
        description: "Present on step_5_output_mode.",
      },
      mode_three_subtype: {
        type: "string",
        enum: ["known_unknown", "unknown_unknown"],
        description:
          "Present when output_mode = mode_three. " +
          "known_unknown: experiment is definable. " +
          "unknown_unknown: gap is narrow but not yet experimentally specifiable.",
      },
      lossy_decomposition_applies: {
        type: "boolean",
        description:
          "True when emergence or wicked-problem markers were flagged at Step 1. " +
          "When true, the output must include an explicit lossy decomposition note.",
      },
    },
    required: ["component_id", "step"],
  },
};

export const VERIFICATION_RETURN_TOOL: Tool = {
  name: "verification_return",
  description:
    "Return the verification result for the component classification received. " +
    "The verification agent calls this tool after evaluating what was passed. " +
    "The result is either confirmed or disputed — no other states.",
  input_schema: {
    type: "object" as const,
    properties: {
      classification_received: {
        type: "string",
        enum: ["frontier", "design", "resolved"],
        description: "The classification that was passed for evaluation.",
      },
      result: {
        type: "string",
        enum: ["confirmed", "disputed"],
      },
      ground: {
        type: "string",
        description:
          "The specific precedent or reasoning the verification agent used to reach its result.",
      },
      dispute_reason: {
        type: "string",
        description: "Present when result = disputed. States precisely what is wrong.",
      },
      refined_classification: {
        type: "string",
        enum: ["frontier", "design", "resolved"],
        description:
          "Present when result = disputed. The correct classification with named solution or refined question.",
      },
      refined_question: {
        type: "string",
        description:
          "Present when the verification agent refines a candidate frontier to a more precise question.",
      },
      flags: {
        type: "array",
        description:
          "Component categories that are structurally expected for this idea type " +
          "but absent from the components passed so far. The main agent must state " +
          "a disposition for each flag before proceeding.",
        items: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: [
                "missing_assumption",
                "missing_dependency",
                "missing_expert_obvious",
              ],
            },
            description: { type: "string" },
          },
          required: ["category", "description"],
        },
      },
      compound_tradeoff_detected: {
        type: "object",
        description:
          "Present when the verification agent detects a compound tradeoff that " +
          "was passed as a single candidate frontier without decomposition.",
        properties: {
          design_resolvable_element: { type: "string" },
          behavioral_data_element: { type: "string" },
        },
        required: ["design_resolvable_element", "behavioral_data_element"],
      },
    },
    required: ["classification_received", "result", "ground"],
  },
};

export const REQUEST_USER_INPUT_TOOL: Tool = {
  name: "request_user_input",
  description:
    "Pause the pipeline and surface a question to the user. " +
    "Call this when the protocol requires a user response before proceeding: " +
    "(1) Step 0 framing orientation — submission is verdict-seeking and no prior attempts are known; " +
    "(2) Step 0 input quality gate — submission is underspecified; " +
    "(3) Design fork — two precedented resolution paths exist and the choice affects downstream components. " +
    "One call per gate. The pipeline halts until the user answers.",
  input_schema: {
    type: "object" as const,
    properties: {
      question_text: {
        type: "string",
        description: "The exact question to surface to the user.",
      },
      question_type: {
        type: "string",
        enum: ["step0_quality", "step0_framing", "design_fork"],
        description: "Which protocol gate triggered this question.",
      },
    },
    required: ["question_text", "question_type"],
  },
};

// ─── Agent tool allowlists ────────────────────────────────────────────────────
//
// Allowlist-not-denylist: each agent receives ONLY the tools listed here.
// New tools added to this file are unavailable to any agent until explicitly
// added to that agent's allowlist. The list must be modified deliberately —
// never derived from a registry, a spread of all tools, or a denylist.

export const MAIN_AGENT_TOOL_ALLOWLIST: Tool[] = [CLASSIFY_COMPONENT_TOOL, REQUEST_USER_INPUT_TOOL];

export const VERIFICATION_AGENT_TOOL_ALLOWLIST: Tool[] = [VERIFICATION_RETURN_TOOL];

// The explanation agent uses no tools — plain text output only.
// Listed here for completeness so the allowlist pattern covers all three agents.
export const EXPLANATION_AGENT_TOOL_ALLOWLIST: Tool[] = [];

// ─── Layer 1: TypeScript types derived from tool schemas ─────────────────────

export interface SurfacedItemEmission {
  item_id: string;
  disposition: SurfacedItemDisposition;
  reason: string;
  deferred_target?: string;
  elevated_component_id?: string;
}

export interface CompoundPartEmission {
  id: string;
  type: "design_resolvable" | "behavioral_data";
  description: string;
}

export interface VerificationPassPayload {
  verbatim_component: string;
  verbatim_reasoning: string;
  classification: ComponentClassification;
}

export interface ClassifyComponentInput {
  component_id: string;
  step:
    | "step_3_validation_loop"
    | "step_4_verification_pass"
    | "step_5_output_mode";

  // step_3_validation_loop
  classification?: ComponentClassification;
  resolution_ground?: ResolutionGround;
  open_tradeoff?: {
    description: string;
    resolvable_by_reasoning: boolean;
  };
  is_compound_tradeoff?: boolean;
  compound_parts?: CompoundPartEmission[];
  surfaced_item_dispositions?: SurfacedItemEmission[];

  // step_4_verification_pass
  verification_pass?: VerificationPassPayload;

  // step_5_output_mode
  output_mode?: OutputMode;
  mode_three_subtype?: ModeThreeSubtype;
  lossy_decomposition_applies?: boolean;
}

export interface RequestUserInputInput {
  question_text: string;
  question_type: "step0_quality" | "step0_framing" | "design_fork";
}

export interface VerificationReturnInput {
  classification_received: ComponentClassification;
  result: "confirmed" | "disputed";
  ground: string;
  dispute_reason?: string;
  refined_classification?: ComponentClassification;
  refined_question?: string;
  flags: Array<{
    category: "missing_assumption" | "missing_dependency" | "missing_expert_obvious";
    description: string;
  }>;
  compound_tradeoff_detected?: {
    design_resolvable_element: string;
    behavioral_data_element: string;
  };
}

// ─── Layer 2: Verification agent call envelope ────────────────────────────────
//
// THIS IS THE COMPLETE INPUT TO THE VERIFICATION AGENT API CALL.
// Three fields. Nothing else. No session context. No user history. No idea text
// beyond what the main agent's reasoning already contains.
//
// Context-blindness is enforced here — the orchestration layer constructs this
// object from the verify_pass_payload above and passes it as the sole user
// message content to a fresh Anthropic API call with the verification agent
// system prompt. Nothing from SessionState enters this call.

export interface VerificationAgentCallInput {
  component: string;           // verbatim_component from the main agent
  classification: ComponentClassification;
  reasoning: string;           // verbatim_reasoning from the main agent
}

// The system prompt token that identifies a verification agent call.
// Passed as the system message in the API call. Content comes from Section 9
// of the system prompt document — stored in lib/prompts/ (C5).
export const VERIFICATION_AGENT_ROLE = "verification_agent" as const;

// ─── Layer 3: Stream event types ─────────────────────────────────────────────
//
// The orchestration route handler streams these events to the client as
// newline-delimited JSON (NDJSON) over a ReadableStream.
// Each event has a discriminated `type` field.
// The client reconstructs the full session mirror from these events.

export type StreamEvent =
  | { type: "session_created"; sessionId: string; timestamp: string }
  | { type: "input_gate_result"; passed: boolean; failureQuestion?: string }
  | { type: "framing_check_result"; passed: boolean; priorAttemptsStatement?: string; returnedQuestion?: string }
  | { type: "classification_start"; ideaType: string; constraintType: "hard" | "soft"; emergenceMarkers: boolean; wickedProblemMarkers: boolean; liveLayers: LayerId[] }
  | { type: "decomposition_update"; components: Array<{ id: string; index: number; text: string; layerId: LayerId }>; omissionCheck: { embeddedAssumptions: boolean; implicitDependencies: boolean; expertObvious: boolean } }
  | { type: "reasoning_chunk"; componentId: string | null; text: string; sourceAgent: AgentRole }  // NL stream chunk — labeled by which agent produced it
  | { type: "component_classified"; componentId: string; classification: ComponentClassification; resolutionGround?: ResolutionGround; hasOpenTradeoff: boolean; isCompoundTradeoff: boolean }
  | { type: "verification_sent"; componentId: string; timestamp: string }
  | { type: "verification_received"; componentId: string; result: "confirmed" | "disputed"; ground: string; flagCount: number; refinedClassification?: ComponentClassification; sourceAgent: "verification_agent" }
  | { type: "flag_disposition"; componentId: string; flagIndex: number; disposition: "incorporated" | "deferred_to_output" | "elevated_to_component"; elevatedComponentId?: string }
  | { type: "output_mode_determined"; mode: OutputMode; modeThreeSubtype?: ModeThreeSubtype; lossyDecompositionApplies: boolean }
  | { type: "final_output"; output: import("@/lib/session/schema").FinalOutput }
  | { type: "prompts_activated"; activations: Array<{ documentId: string; newVersion: number }> }
  | { type: "awaiting_input"; question: string; questionType: "step0_quality" | "step0_framing" | "design_fork" }
  | { type: "session_paused"; sessionId: string; componentId: string | null }
  | { type: "session_interrupted"; componentId: string | null; reason: string }
  | { type: "error"; message: string; recoverable: boolean };

// Convenience type guard for the client to narrow stream events.
export function isReasoningChunk(event: StreamEvent): event is Extract<StreamEvent, { type: "reasoning_chunk" }> {
  return event.type === "reasoning_chunk";
}

export function isFinalOutput(event: StreamEvent): event is Extract<StreamEvent, { type: "final_output" }> {
  return event.type === "final_output";
}

// ─── Layer 3: Stream encoding ─────────────────────────────────────────────────
// Used by the route handler to encode events into the ReadableStream.
// Used by the client to decode the response body.

export function encodeStreamEvent(event: StreamEvent): string {
  return JSON.stringify(event) + "\n";
}

export function decodeStreamEvent(line: string): StreamEvent {
  return JSON.parse(line) as StreamEvent;
}
