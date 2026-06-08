// C1 — Evaluation pipeline (updated for C3/C4/C11)
//
// Two public entry points:
//   runEvaluationSession  — fresh start; registers conversation, begins loop
//   runConversationLoop   — core loop; also called by control.ts on resume
//
// The loop streams one assistant turn at a time, forwards text deltas as
// reasoning_chunk events, then processes classify_component tool calls:
//   step_3: update session state, emit component_classified
//   step_4: call verification agent (C2) synchronously with retry (C11)
//   step_5: update session state, emit output_mode_determined
//
// On abort, the loop reads the control intent from conversation.ts:
//   "pause" — save state, set session status to paused, exit silently
//   "stop"  — mark in-flight component interrupted, emit session_interrupted

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type {
  StreamEvent,
  ClassifyComponentInput,
  RequestUserInputInput,
  VerificationAgentCallInput,
  VerificationReturnInput,
} from "@/lib/contracts/output";
import type { ComponentState, VerificationPass } from "@/lib/session/schema";
import { MAIN_AGENT_TOOL_ALLOWLIST } from "@/lib/contracts/output";
import { callVerificationAgent } from "@/lib/agents/verification";
import { getSession, updateSession } from "@/lib/session/store";
import {
  getConversation,
  registerConversation,
  saveMessages,
  setConversationStatus,
} from "@/lib/session/conversation";
import { MAIN_AGENT_SYSTEM_PROMPT } from "@/lib/prompts";
import { getActiveContent, getAllDocuments } from "@/lib/documents/registry";
import { withRetry, classifyError, isAbortError, makeAbortError } from "@/lib/orchestration/errors";
import { appendAuditEvent } from "@/lib/audit/log";
import type { PromptVersionSnapshot } from "@/lib/audit/types";
import { activateOnSessionCompletion } from "@/lib/versioning/activation";

const MAIN_AGENT_MODEL = "claude-opus-4-8";
const MAIN_AGENT_MAX_TOKENS = 8192;

// ─── Error type ───────────────────────────────────────────────────────────────

export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly recoverable: boolean = false
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPromptVersionSnapshot(): PromptVersionSnapshot {
  const docs = getAllDocuments();
  const mainDoc = docs.find((d) => d.agentRole === "main_agent");
  const verifDoc = docs.find((d) => d.agentRole === "verification_agent");
  return {
    main_agent: mainDoc?.version ?? 0,
    verification_agent: verifDoc?.version ?? 0,
  };
}

function durationFromCreatedAt(createdAt: string | undefined): number | null {
  if (!createdAt) return null;
  return Date.now() - new Date(createdAt).getTime();
}

// ─── Public entry points ──────────────────────────────────────────────────────

export async function runEvaluationSession(
  sessionId: string,
  ideaSubmission: string,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  const initialMessages: MessageParam[] = [
    { role: "user", content: ideaSubmission },
  ];

  registerConversation(sessionId, initialMessages);

  appendAuditEvent({
    category: "session_lifecycle",
    type: "session_init",
    sessionId,
    timestamp: new Date().toISOString(),
    ideaLength: ideaSubmission.length,
    promptVersions: getPromptVersionSnapshot(),
  });

  onEvent({
    type: "session_created",
    sessionId,
    timestamp: new Date().toISOString(),
  });

  await runConversationLoop(sessionId, initialMessages, null, onEvent);
}

// Exported for the resume path in control.ts.
// Takes the messages array as it was saved at the last completed turn boundary.
export async function runConversationLoop(
  sessionId: string,
  initialMessages: MessageParam[],
  initialComponentId: string | null,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  const conv = getConversation(sessionId);
  if (!conv) {
    onEvent({
      type: "error",
      message: `Session ${sessionId} not found in conversation store`,
      recoverable: false,
    });
    return;
  }

  const client = new Anthropic();
  // Work on a local copy — saveMessages persists it to the store each turn.
  const messages: MessageParam[] = [...initialMessages];
  let currentComponentId: string | null = initialComponentId;

  try {
    while (true) {
      // Persist before each API call so a mid-stream pause has a clean
      // recovery point at the last completed turn boundary.
      saveMessages(sessionId, messages, currentComponentId);

      // Check abort before starting the next API call.
      if (conv.abortController.signal.aborted) {
        handleAbort(sessionId, currentComponentId, onEvent);
        return;
      }

      const stream = client.messages.stream(
        {
          model: MAIN_AGENT_MODEL,
          max_tokens: MAIN_AGENT_MAX_TOKENS,
          // Read active version from registry so C8 prompt updates take effect.
          system: getActiveContent("main_agent") ?? MAIN_AGENT_SYSTEM_PROMPT,
          messages,
          tools: MAIN_AGENT_TOOL_ALLOWLIST,
        },
        { signal: conv.abortController.signal }
      );

      stream.on("text", (textDelta) => {
        onEvent({
          type: "reasoning_chunk",
          componentId: currentComponentId,
          text: textDelta,
          sourceAgent: "main_agent",
        });
      });

      stream.on("contentBlock", (block) => {
        if (block.type === "server_tool_use" && block.name === "web_search") {
          const input = block.input as { query?: string };
          onEvent({
            type: "reasoning_chunk",
            componentId: currentComponentId,
            text: `\n[web search: "${input.query ?? ""}"]\n`,
            sourceAgent: "main_agent",
          });
        } else if (block.type === "web_search_tool_result") {
          const content = block.content;
          let text: string;
          if (!Array.isArray(content)) {
            text = `\n[search error: ${content.error_code}]\n`;
          } else if (content.length === 0) {
            text = `\n[search returned no results]\n`;
          } else {
            const items = content.map((r) => `  • ${r.title} — ${r.url}`).join("\n");
            text = `\n[${content.length} result${content.length === 1 ? "" : "s"}]\n${items}\n`;
          }
          onEvent({
            type: "reasoning_chunk",
            componentId: currentComponentId,
            text,
            sourceAgent: "main_agent",
          });
        }
      });

      let response;
      try {
        response = await stream.finalMessage();
      } catch (err) {
        if (isAbortError(err) || conv.abortController.signal.aborted) {
          handleAbort(sessionId, currentComponentId, onEvent);
          return;
        }
        throw err;
      }

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "end_turn") {
        updateSession(sessionId, (s) => {
          s.status = "completed";
        });
        setConversationStatus(sessionId, "stopped");

        // C12: snapshot must precede activation so session_close records what the session used.
        const preActivationVersions = getPromptVersionSnapshot();
        const activations = activateOnSessionCompletion(sessionId);

        if (activations.length > 0) {
          onEvent({ type: "prompts_activated", activations });
        }

        const session = getSession(sessionId);
        appendAuditEvent({
          category: "session_lifecycle",
          type: "session_close",
          sessionId,
          timestamp: new Date().toISOString(),
          terminalStatus: "completed",
          outputMode: session?.outputMode ?? null,
          promptVersions: preActivationVersions,
          durationMs: durationFromCreatedAt(session?.createdAt),
        });

        break;
      }

      if (response.stop_reason === "tool_use") {
        // Protocol-initiated pause: agent requested user input.
        // Save messages (includes this assistant turn with the tool_use block)
        // and exit cleanly. The respond endpoint will inject the tool_result
        // with the user's answer and resume the loop.
        const inputRequestBlock = response.content.find(
          (b): b is ToolUseBlock =>
            b.type === "tool_use" && b.name === "request_user_input"
        );
        if (inputRequestBlock) {
          const input = inputRequestBlock.input as RequestUserInputInput;
          handleRequestUserInput(
            sessionId,
            input,
            inputRequestBlock.id,
            onEvent
          );
          saveMessages(sessionId, messages, currentComponentId);
          setConversationStatus(sessionId, "waiting_for_input");
          return;
        }

        const toolUseBlocks = response.content.filter(
          (b): b is ToolUseBlock =>
            b.type === "tool_use" && b.name === "classify_component"
        );

        const toolResults: ToolResultBlockParam[] = [];

        for (const block of toolUseBlocks) {
          const input = block.input as ClassifyComponentInput;
          const result = await processClassifyComponent(
            sessionId,
            input,
            onEvent,
            (id) => {
              currentComponentId = id;
            }
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }

        messages.push({ role: "user", content: toolResults });
        continue;
      }

      if (response.stop_reason === "pause_turn") {
        // Server-side tool loop hit the iteration ceiling; the API will resume
        // automatically when we re-send the conversation as-is (no user turn needed).
        continue;
      }

      throw new PipelineError(
        `Unexpected stop_reason: ${response.stop_reason}`,
        false
      );
    }
  } catch (err) {
    if (isAbortError(err) || conv.abortController.signal.aborted) {
      handleAbort(sessionId, currentComponentId, onEvent);
      return;
    }

    const { message, recoverable } = classifyError(err);

    appendAuditEvent({
      category: "pipeline_error",
      type: "pipeline_error",
      sessionId,
      timestamp: new Date().toISOString(),
      message,
      recoverable,
      errorClass: err instanceof Error ? err.name : "UnknownError",
    });

    const session = getSession(sessionId);
    appendAuditEvent({
      category: "session_lifecycle",
      type: "session_close",
      sessionId,
      timestamp: new Date().toISOString(),
      terminalStatus: "error",
      outputMode: session?.outputMode ?? null,
      promptVersions: getPromptVersionSnapshot(),
      durationMs: durationFromCreatedAt(session?.createdAt),
    });

    onEvent({ type: "error", message, recoverable });
    updateSession(sessionId, (s) => {
      s.status = "interrupted";
    });
    setConversationStatus(sessionId, "stopped");
  }
}

// ─── Abort handler ────────────────────────────────────────────────────────────

function handleAbort(
  sessionId: string,
  currentComponentId: string | null,
  onEvent: (event: StreamEvent) => void
): void {
  const conv = getConversation(sessionId);
  const intent = conv?.controlIntent ?? "stop";

  if (intent === "pause") {
    // Emit session_paused so the client can distinguish stream closure due to
    // pause from stream closure due to completion or error. The session status
    // was already set to "paused" by control.ts before the abort signal.
    onEvent({ type: "session_paused", sessionId, componentId: currentComponentId });
    return;
  }

  // "stop" intent (C4): apply the interrupted label.
  // Completed components remain intact. In-flight component marked interrupted.
  onEvent({
    type: "session_interrupted",
    componentId: currentComponentId,
    reason: "Stopped by user",
  });

  updateSession(sessionId, (s) => {
    s.status = "interrupted";
    if (currentComponentId) {
      const comp = s.decomposition.components.find(
        (c) => c.id === currentComponentId
      );
      if (comp && comp.status !== "verified") {
        comp.status = "interrupted";
      }
    }
  });

  const session = getSession(sessionId);
  appendAuditEvent({
    category: "session_lifecycle",
    type: "session_close",
    sessionId,
    timestamp: new Date().toISOString(),
    terminalStatus: "interrupted",
    outputMode: session?.outputMode ?? null,
    promptVersions: getPromptVersionSnapshot(),
    durationMs: durationFromCreatedAt(session?.createdAt),
  });
}

// ─── Protocol-initiated pause ─────────────────────────────────────────────────

function handleRequestUserInput(
  sessionId: string,
  input: RequestUserInputInput,
  toolUseId: string,
  onEvent: (event: StreamEvent) => void
): void {
  updateSession(sessionId, (s) => {
    s.status = "waiting_for_input";
    s.pendingQuestion = {
      text: input.question_text,
      questionType: input.question_type,
      toolUseId,
    };
  });
  onEvent({
    type: "awaiting_input",
    question: input.question_text,
    questionType: input.question_type,
  });
}

// ─── Tool call dispatcher ─────────────────────────────────────────────────────

async function processClassifyComponent(
  sessionId: string,
  input: ClassifyComponentInput,
  onEvent: (event: StreamEvent) => void,
  setCurrentComponentId: (id: string) => void
): Promise<object> {
  switch (input.step) {
    case "step_3_validation_loop":
      return handleStep3(sessionId, input, onEvent, setCurrentComponentId);
    case "step_4_verification_pass":
      return handleStep4(sessionId, input, onEvent);
    case "step_5_output_mode":
      return handleStep5(sessionId, input, onEvent);
    default:
      throw new PipelineError(
        `Unknown classify_component step: ${(input as ClassifyComponentInput).step}`
      );
  }
}

// ─── Step 3: Component classification ────────────────────────────────────────

function handleStep3(
  sessionId: string,
  input: ClassifyComponentInput,
  onEvent: (event: StreamEvent) => void,
  setCurrentComponentId: (id: string) => void
): object {
  const componentId = input.component_id;
  setCurrentComponentId(componentId);

  updateSession(sessionId, (s) => {
    const existing = s.decomposition.components.find(
      (c) => c.id === componentId
    );

    if (!existing) {
      const firstLiveLayer = s.validationLayers.find((l) => l.live);
      const newComponent: ComponentState = {
        id: componentId,
        index: s.decomposition.components.length,
        // Component text is a placeholder until step_4 provides the verbatim text.
        text: componentId,
        layerId: firstLiveLayer?.id ?? "fundamental_coherence",
        classification: input.classification ?? null,
        classificationReasoning: "",
        resolutionGround: input.resolution_ground,
        openTradeoff: input.open_tradeoff
          ? {
              description: input.open_tradeoff.description,
              resolvableByReasoning: input.open_tradeoff.resolvable_by_reasoning,
            }
          : undefined,
        isCompoundTradeoff: input.is_compound_tradeoff ?? false,
        compoundParts: input.compound_parts?.map((p) => ({
          id: p.id,
          type: p.type,
          description: p.description,
        })),
        isContingentPrerequisite: false,
        prerequisiteFor: [],
        isDesignFork: false,
        surfacedItems: (input.surfaced_item_dispositions ?? []).map((d) => ({
          id: d.item_id,
          content: "",
          disposition: d.disposition,
          dispositionReason: d.reason,
          deferredTarget: d.deferred_target,
          elevatedComponentId: d.elevated_component_id,
        })),
        verificationPass: null,
        status: "classifying",
      };
      s.decomposition.components.push(newComponent);

      onEvent({
        type: "decomposition_update",
        components: s.decomposition.components.map((c) => ({
          id: c.id,
          index: c.index,
          text: c.text,
          layerId: c.layerId,
        })),
        omissionCheck: s.decomposition.omissionCheck,
      });
    } else {
      existing.classification = input.classification ?? existing.classification;
      existing.resolutionGround = input.resolution_ground;
      if (input.open_tradeoff) {
        existing.openTradeoff = {
          description: input.open_tradeoff.description,
          resolvableByReasoning: input.open_tradeoff.resolvable_by_reasoning,
        };
      }
      existing.isCompoundTradeoff = input.is_compound_tradeoff ?? false;
      if (input.compound_parts) {
        existing.compoundParts = input.compound_parts.map((p) => ({
          id: p.id,
          type: p.type,
          description: p.description,
        }));
      }
      existing.status = "classifying";
    }
  });

  onEvent({
    type: "component_classified",
    componentId,
    classification: input.classification ?? "resolved",
    resolutionGround: input.resolution_ground,
    hasOpenTradeoff: !!input.open_tradeoff,
    isCompoundTradeoff: input.is_compound_tradeoff ?? false,
  });

  return { acknowledged: true, component_id: componentId };
}

// ─── Step 4: Verification pass ────────────────────────────────────────────────
//
// Calls C2 (callVerificationAgent) with retry (C11).
// The 3-field VerificationAgentCallInput is constructed here —
// nothing from SessionState enters the verification call.

async function handleStep4(
  sessionId: string,
  input: ClassifyComponentInput,
  onEvent: (event: StreamEvent) => void
): Promise<object> {
  const pass = input.verification_pass;
  if (!pass) {
    throw new PipelineError(
      "step_4_verification_pass called without verification_pass payload"
    );
  }

  const componentId = input.component_id;
  const sentAt = new Date().toISOString();

  onEvent({ type: "verification_sent", componentId, timestamp: sentAt });

  // C2 call site. Three fields only. TypeScript enforces no session context enters.
  const verificationInput: VerificationAgentCallInput = {
    component: pass.verbatim_component,
    classification: pass.classification,
    reasoning: pass.verbatim_reasoning,
  };

  // C14: get the session abort signal for continuous stop detection.
  // The signal is infrastructure — it does not enter the verification agent's
  // context window and does not violate the context-blindness invariant.
  const signal = getConversation(sessionId)?.abortController.signal;

  // C11: retry transient errors up to 3 times with exponential backoff.
  // C14: pass signal so abort fires abort the HTTP call and interrupt retry sleeps.
  let verificationResult: VerificationReturnInput;
  try {
    verificationResult = await withRetry(
      () => callVerificationAgent(verificationInput, signal),
      { signal }
    );
  } catch (err) {
    // Let abort errors propagate unwrapped so the pipeline routes them to
    // handleAbort (interrupted label) rather than the pipeline_error audit path.
    if (isAbortError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new PipelineError(`Verification agent failed: ${message}`, false);
  }

  // C14: cover the race window where the API call completed just as stop fired.
  // Without this check the result would be processed and the stop would only be
  // noticed at the next loop boundary (node-boundary-only detection).
  if (signal?.aborted) throw makeAbortError();

  const receivedAt = new Date().toISOString();

  updateSession(sessionId, (s) => {
    const comp = s.decomposition.components.find((c) => c.id === componentId);
    if (!comp) return;

    // Update the component text with the verbatim text from the verification pass.
    comp.text = pass.verbatim_component;

    const vPass: VerificationPass = {
      sentAt,
      verbatimComponent: pass.verbatim_component,
      verbatimReasoning: pass.verbatim_reasoning,
      classificationSent: pass.classification,
      receivedAt,
      result: verificationResult.result,
      ground: verificationResult.ground,
      disputeReason: verificationResult.dispute_reason,
      refinedClassification: verificationResult.refined_classification,
      refinedQuestion: verificationResult.refined_question,
      flags: (verificationResult.flags ?? []).map((f) => ({
        category: f.category,
        content: f.description,
        // Disposition is pending — the main agent must state it in NL reasoning.
        disposition: "incorporated" as const,
        dispositionReason: "pending main agent disposition",
      })),
    };

    comp.verificationPass = vPass;

    if (verificationResult.result === "confirmed") {
      comp.status = "verified";
      if (verificationResult.refined_classification) {
        comp.classification = verificationResult.refined_classification;
      }
    }
    // On dispute: status stays "classifying"; main agent calls step_3 again.
  });

  onEvent({
    type: "verification_received",
    componentId,
    result: verificationResult.result,
    ground: verificationResult.ground,
    flagCount: verificationResult.flags?.length ?? 0,
    refinedClassification: verificationResult.refined_classification,
    sourceAgent: "verification_agent",
  });

  return {
    result: verificationResult.result,
    ground: verificationResult.ground,
    dispute_reason: verificationResult.dispute_reason ?? null,
    refined_classification: verificationResult.refined_classification ?? null,
    refined_question: verificationResult.refined_question ?? null,
    flags: verificationResult.flags ?? [],
    compound_tradeoff_detected:
      verificationResult.compound_tradeoff_detected ?? null,
  };
}

// ─── Step 5: Output mode determination ───────────────────────────────────────

function handleStep5(
  sessionId: string,
  input: ClassifyComponentInput,
  onEvent: (event: StreamEvent) => void
): object {
  if (!input.output_mode) {
    throw new PipelineError(
      "step_5_output_mode called without output_mode field"
    );
  }

  updateSession(sessionId, (s) => {
    s.outputMode = input.output_mode!;
    if (input.mode_three_subtype) {
      s.modeThreeSubtype = input.mode_three_subtype;
    }
    if (input.lossy_decomposition_applies && !s.lossyDecompositionNote) {
      s.lossyDecompositionNote =
        "Lossy decomposition applies — emergence or wicked-problem markers present.";
    }
    s.status = "producing_output";
  });

  onEvent({
    type: "output_mode_determined",
    mode: input.output_mode,
    modeThreeSubtype: input.mode_three_subtype,
    lossyDecompositionApplies: input.lossy_decomposition_applies ?? false,
  });

  return { acknowledged: true, mode: input.output_mode };
}
