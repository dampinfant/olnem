// C9 — State management schema
// Every protocol-named condition is a first-class discriminated type.
// No ad-hoc string fields carrying classification state.

// ─── Primitive enumerations ──────────────────────────────────────────────────

export type ComponentClassification = "frontier" | "design" | "resolved" | "interrupted";

export type VerificationResult = "confirmed" | "disputed";

export type ResolutionGround = "precedent" | "logical_coherence";

export type SurfacedItemDisposition = "dismissed" | "deferred" | "elevated";

export type FlagDisposition =
  | "incorporated"
  | "deferred_to_output"
  | "elevated_to_component";

export type OutputMode = "mode_one" | "mode_two" | "mode_three";

// Mode three subtype — determines what the user's next move looks like.
// (a) known_unknown: gap is named and experiment is definable.
// (b) unknown_unknown: gap is narrow but not yet experimentally specifiable.
export type ModeThreeSubtype = "known_unknown" | "unknown_unknown";

export type ConstraintType = "hard" | "soft";

export type ComponentStatus =
  | "pending"
  | "classifying"
  | "awaiting_verification"
  | "verified"
  | "interrupted";

export type SessionStatus =
  | "active"
  | "awaiting_input"
  | "waiting_for_input"  // protocol-initiated pause: pipeline emitted a question and halted
  | "paused"             // C3: evaluation paused, conversation state saved, can be resumed
  | "producing_output"
  | "completed"
  | "interrupted";       // C4: stopped by user — in-flight component marked interrupted

// ─── Validation layers ────────────────────────────────────────────────────────

export type LayerId =
  | "fundamental_coherence"
  | "empirical_precedent"
  | "structural_viability"
  | "implementation_gap"
  | "abstract";

export interface ValidationLayer {
  id: LayerId;
  live: boolean;
  removalReason?: string;
}

// ─── Surfaced items ───────────────────────────────────────────────────────────
// Any epistemic finding surfaced inside the validation loop that is not the
// component's resolution and not a previously named component.
// Disposition is mandatory before passing to verification. (iteration 10 rule)

export interface SurfacedItem {
  id: string;
  content: string;
  disposition: SurfacedItemDisposition;
  dispositionReason: string;
  deferredTarget?: string;      // component_id or literal "output"
  elevatedComponentId?: string; // present when disposition = "elevated"
}

// ─── Verification flag ────────────────────────────────────────────────────────
// Appended by the verification agent alongside a "confirmed" result.
// Must have a named disposition before the session proceeds. (iteration 9 rule)

export interface VerificationFlag {
  category: "missing_assumption" | "missing_dependency" | "missing_expert_obvious";
  content: string;
  disposition: FlagDisposition;
  dispositionReason: string;
  elevatedComponentId?: string;
}

// ─── Verification pass record ─────────────────────────────────────────────────
// Full record of what was sent to the verification agent and what came back.
// verbatimComponent and verbatimReasoning are never summarized or paraphrased —
// the protocol requires verbatim pass. Summarization is a framing effect.

export interface VerificationPass {
  sentAt: string;                          // ISO 8601
  verbatimComponent: string;
  verbatimReasoning: string;
  classificationSent: ComponentClassification;
  receivedAt?: string;                     // ISO 8601, present when complete
  result?: VerificationResult;
  ground?: string;
  disputeReason?: string;
  refinedClassification?: ComponentClassification;
  refinedQuestion?: string;
  flags: VerificationFlag[];
}

// ─── Open tradeoff ────────────────────────────────────────────────────────────
// Present when a component resolves on logical coherence with a named
// unquantified tradeoff. The frontier candidate test must be applied:
// if resolvableByReasoning = false, the component must be reclassified. (iteration 4)

export interface OpenTradeoff {
  description: string;
  resolvableByReasoning: boolean;
}

// ─── Compound tradeoff ────────────────────────────────────────────────────────
// When a tradeoff contains one design-resolvable sub-element and one requiring
// behavioral data, it must be decomposed before passing. (iteration 5)

export interface CompoundPart {
  id: string;
  type: "design_resolvable" | "behavioral_data";
  description: string;
  classification?: ComponentClassification;
  verificationPass?: VerificationPass;
}

// ─── Design fork ──────────────────────────────────────────────────────────────
// Two or more precedented resolution paths for a single component.
// Downstream consequences must be stated before the user chooses. (iteration 8)

export interface DesignForkPath {
  description: string;
  downstreamConsequence: string;    // one sentence, stated before user chooses
  affectedComponentIds: string[];
}

// ─── Component state ──────────────────────────────────────────────────────────
// The atomic unit of the validation loop. Every protocol-named condition
// (open tradeoff, compound tradeoff, contingent sub-question, design fork,
// scope fork, surfaced items, verification flags) is explicit here.

export interface ComponentState {
  id: string;
  index: number;
  text: string;
  layerId: LayerId;

  // Classification
  classification: ComponentClassification | null;
  classificationReasoning: string;
  resolutionGround?: ResolutionGround;

  // Open tradeoff (iteration 4)
  openTradeoff?: OpenTradeoff;

  // Compound tradeoff (iteration 5)
  // When true, component must be split into compoundParts before verification.
  isCompoundTradeoff: boolean;
  compoundParts?: CompoundPart[];

  // Contingent sub-question (iteration 9)
  // This component is the load-bearing prerequisite for the components listed.
  // Their classification is contingent on this one's result.
  isContingentPrerequisite: boolean;
  prerequisiteFor: string[];         // component_ids

  // Design fork (iteration 8)
  isDesignFork: boolean;
  designForkPaths?: DesignForkPath[];
  activeDesignForkPathIndex?: number;

  // In-loop surfaced items (iteration 10)
  surfacedItems: SurfacedItem[];

  // Verification
  verificationPass: VerificationPass | null;

  status: ComponentStatus;
}

// ─── Scope fork ───────────────────────────────────────────────────────────────
// When decomposition produces two or more sub-problems requiring separate
// validation passes. Each sub-problem runs the full loop before output. (iteration 7)

export interface SubProblem {
  id: string;
  componentIds: string[];
  status: "pending" | "in_progress" | "completed" | "deferred";
  deferMarker?: string; // names the pause point if deferred mid-session
}

export interface ScopeFork {
  id: string;
  description: string;
  orderingBasis: string; // explicit statement of why this sub-problem runs first
  subProblems: SubProblem[];
}

// ─── Final output ─────────────────────────────────────────────────────────────

export interface WhatHoldsEntry {
  componentId: string;
  componentText: string;
  resolutionGround: ResolutionGround;
  summary: string;
}

export interface FrontierQuestion {
  index: number;
  label: string;
  question: string;
  isGenuineFrontier: boolean; // false = Phase 3 design item, labeled not-a-frontier
  modeThreeSubtype?: ModeThreeSubtype;
}

export interface LossyDecompositionNote {
  note: string;
  covers: string;
  doesNotCover: string;
}

export interface FinalOutput {
  mode: OutputMode;

  // All three modes
  whatHolds: WhatHoldsEntry[];
  whatAlreadyHappened: string;
  whatIsNovel: string;

  // Mode one + three
  frontierQuestions?: FrontierQuestion[];
  whatRequiresExternalInput?: string; // mode one only

  // Mode three only
  whatResolvesIfGapCloses?: string;

  // Mode two only
  structuralSoundnessStatement?: string;
  layersConfirmed?: LayerId[];
  implementationPath?: string;

  // Lossy decomposition qualifier — accompanies whichever mode applies
  // when emergence or wicked-problem markers were flagged at Step 1
  lossyDecomposition?: LossyDecompositionNote;
}

// ─── Session state ────────────────────────────────────────────────────────────
// The single source of truth for one evaluation session.
// Lives server-side (in-memory); mirrored to client as read-only.

export interface SessionState {
  id: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  ideaSubmission: string;

  // Step 0: Input quality gate
  // If passed = false, failureQuestion is returned to user and evaluation halts.
  inputGate: {
    passed: boolean | null;
    failureQuestion?: string;
  };

  // Step 0: Framing orientation check (iteration 12)
  // priorAttemptsStatement must be explicit — not just a boolean pass.
  // A silent pass without naming prior attempts is a Step 0 gap.
  framingOrientation: {
    isVerdictSeeking: boolean | null;
    priorAttemptsAvailable: boolean | null;
    priorAttemptsStatement?: string;  // named explicitly, not implied
    returnedQuestion?: string;        // present if no prior attempts available
    passed: boolean | null;
  };

  // Step 1: Idea type classification
  ideaType: string | null;
  constraintType: ConstraintType | null;
  softConstraintNote?: string;
  hasEmergenceMarkers: boolean;
  hasWickedProblemMarkers: boolean;
  lossyDecompositionNote?: string; // present when either marker is true
  validationLayers: ValidationLayer[];

  // Step 2: Visible decomposition
  // omissionCheck tracks whether the three categories were explicitly checked.
  decomposition: {
    components: ComponentState[];
    omissionCheck: {
      embeddedAssumptions: boolean;
      implicitDependencies: boolean;
      expertObvious: boolean;
    };
  };

  scopeForks: ScopeFork[];

  // Step 5: Output mode
  outputMode: OutputMode | null;
  modeThreeSubtype?: ModeThreeSubtype;

  status: SessionStatus;

  // Set when status = waiting_for_input. Cleared by the respond endpoint.
  pendingQuestion?: {
    text: string;
    questionType: "step0_quality" | "step0_framing" | "design_fork";
    toolUseId: string;
  };

  finalOutput: FinalOutput | null;
}

// ─── Session store type ────────────────────────────────────────────────────────
// The in-memory store maps session IDs to live state.
// Imported by the server-side session manager only — not exposed to client.

export type SessionStore = Map<string, SessionState>;
