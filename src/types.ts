export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ToolClassification =
  | "mutation"
  | "verification"
  | "read"
  | "ignored"
  | "unknown";
export type VerificationStatus = "clean" | "stale" | "verified" | "waived";
export type TransitionEffect =
  | "progress"
  | "no_progress"
  | "regression"
  | "terminal"
  | "unknown";

export interface ModelRefV1 {
  provider: string;
  id: string;
  thinkingLevel?: string;
}

export interface ObservationRefV1 {
  version: 1;
  kind: "observation_ref";
  source: "run" | "session" | "tool" | "artifact";
  ref: string;
  hash?: string;
}

export interface ActionV1 {
  version: 1;
  kind: "action";
  tool: string;
  identityHash: string;
  label?: string;
}

export interface BudgetDeltaV1 {
  actions?: number;
  modelRequests?: number;
  elapsedMs?: number;
}

export interface TransitionV1 {
  version: 1;
  kind: "transition";
  id: string;
  observationBefore: ObservationRefV1;
  action: ActionV1;
  observationAfter: ObservationRefV1;
  effect: TransitionEffect;
  budgetDelta: BudgetDeltaV1;
  evidenceRefs: string[];
  occurredAt: string;
}

export interface ProgressSignalV1 {
  version: 1;
  kind: "progress_signal";
  transitionId: string;
  effect: TransitionEffect;
  score?: number;
  reason: string;
}

export type BeliefArea =
  | "world_model"
  | "goal_model"
  | "action_model"
  | "recent_finding"
  | "open_question"
  | "current_plan"
  | "cross_task_knowledge";
export type BeliefStatus = "active" | "contradicted" | "retired";

export interface BeliefClaimV1 {
  version: 1;
  kind: "belief_claim";
  id: string;
  area: BeliefArea;
  claim: string;
  confidence: number;
  scope: string;
  supportingEvidence: string[];
  contradictingEvidence: string[];
  freshnessEpoch: number;
  status: BeliefStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BeliefStateV1 {
  version: 1;
  kind: "belief_state";
  claims: Record<string, BeliefClaimV1>;
}

export interface VerificationEvidenceV1 {
  version: 1;
  kind: "verification_evidence";
  id: string;
  mutationEpoch: number;
  toolCallId: string;
  classifier: string;
  commandIdentityHash: string;
  resultHash: string;
  observedAt: string;
  success: true;
  label?: string;
}

export interface VerificationWaiverV1 {
  version: 1;
  kind: "verification_waiver";
  id: string;
  mutationEpoch: number;
  reason: string;
  observedAt: string;
}

export interface MutationRefV1 {
  eventId: string;
  epoch: number;
  toolCallId: string;
  toolName: string;
  identityHash: string;
  observedAt: string;
}

export interface VerificationStateV1 {
  version: 1;
  kind: "verification_state";
  status: VerificationStatus;
  mutationEpoch: number;
  latestMutation?: MutationRefV1;
  coveringEvidence?: VerificationEvidenceV1;
  coveringWaiver?: VerificationWaiverV1;
  stopContinuations: number;
}

export type HypothesisStatus =
  | "live"
  | "falsified"
  | "dominated"
  | "selected"
  | "deferred";

export interface EvidenceRefV1 {
  kind: "run_event" | "tool_call" | "artifact" | "unverified_note";
  ref: string;
  note?: string;
}

export interface PredictionV1 {
  id: string;
  description: string;
  observable: string;
}

export interface FalsificationTestV1 {
  description: string;
  estimatedCost?: Record<string, number>;
  risk?: "read-only" | "reversible" | "irreversible";
}

export interface HypothesisV1 {
  version: 1;
  kind: "hypothesis";
  id: string;
  mechanism: string;
  evidenceFor: EvidenceRefV1[];
  evidenceAgainst: EvidenceRefV1[];
  predictions: PredictionV1[];
  falsificationTest?: FalsificationTestV1;
  confidence: number;
  status: HypothesisStatus;
  createdAt: string;
  updatedAt: string;
}

export type HypothesisOperation =
  | { operation: "create"; hypothesis: HypothesisV1 }
  | {
      operation: "add_evidence";
      id: string;
      side: "for" | "against";
      evidence: EvidenceRefV1;
    }
  | { operation: "add_prediction"; id: string; prediction: PredictionV1 }
  | {
      operation: "set_falsification_test";
      id: string;
      test: FalsificationTestV1;
    }
  | { operation: "set_confidence"; id: string; confidence: number }
  | {
      operation: "set_status";
      id: string;
      status: HypothesisStatus;
      reopenReason?: string;
      evidence?: EvidenceRefV1;
    }
  | { operation: "list" }
  | { operation: "get"; id: string };

export interface HypothesisEventV1 {
  version: 1;
  kind: "hypothesis_event";
  id: string;
  eventId: string;
  operation: Exclude<HypothesisOperation["operation"], "list" | "get">;
  payload: JsonObject;
  occurredAt: string;
}

export interface VerificationPolicyV1 {
  commandPatterns: string[];
  mutationCommandPatterns: string[];
  ignoreCommandPatterns: string[];
  maxStopContinuations: number;
}

export type RefinerTrigger =
  | "verification_failure"
  | "repeated_tool_failure"
  | "budget_stagnation"
  | "successful_milestone"
  | "belief_contradiction";

export interface RefinerPolicyV1 {
  enabled: boolean;
  autoActivate: boolean;
  model: string;
  thinkingLevel: "minimal" | "low" | "medium" | "high";
  triggers: RefinerTrigger[];
  maxRuns: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRuntimeMs: number;
  stagnationActionLimit: number;
  repeatedFailureLimit: number;
}

export interface EvaluationPolicyV1 {
  condition: "stock" | "ledger" | "state" | "refiner" | "executable_model";
  taskId?: string;
}

export interface ProjectPolicyV1 {
  version: 1;
  verification: VerificationPolicyV1;
  refiner: RefinerPolicyV1;
  evaluation: EvaluationPolicyV1;
}

export type ComponentKind = "policy_overlay" | "skill" | "agent" | "memory";
export type ComponentStatus =
  | "proposed"
  | "schema_valid"
  | "policy_valid"
  | "canary_valid"
  | "active"
  | "rejected"
  | "rolled_back";

export interface PolicyOverlayPayloadV1 {
  instructions: string;
}

export interface SkillPayloadV1 {
  description: string;
  instructions: string;
}

export interface AgentPayloadV1 {
  description: string;
  instructions: string;
  tools: string[];
  modelRole?: string;
}

export interface MemoryPayloadV1 {
  claim: string;
  confidence: number;
  scope: string;
  evidenceRefs: string[];
}

export type ComponentPayloadV1 =
  | PolicyOverlayPayloadV1
  | SkillPayloadV1
  | AgentPayloadV1
  | MemoryPayloadV1;

export interface ComponentMetricSnapshotV1 {
  actions: number;
  verificationFailures: number;
  regressions: number;
  successfulVerifications: number;
}

export interface ComponentRevisionV1 {
  version: 1;
  kind: "component_revision";
  id: string;
  componentKind: ComponentKind;
  name: string;
  parentRevisionId?: string;
  contentHash: string;
  payload: ComponentPayloadV1;
  status: ComponentStatus;
  rationale: string;
  proposedBy: "user" | "model" | "refiner";
  triggerEventId?: string;
  validators: string[];
  validationErrors: string[];
  metricsBefore?: ComponentMetricSnapshotV1;
  metricsAfter?: ComponentMetricSnapshotV1;
  createdAt: string;
  updatedAt: string;
}
export interface ComponentRevisionRefV1 {
  version: 1;
  kind: "component_revision_ref";
  revisionId: string;
  componentKind: ComponentKind;
  name: string;
  lifecycle: ComponentStatus;
  contentHash: string;
  parentRevisionId?: string;
  validators: string[];
  validationErrors: string[];
  proposedBy: ComponentRevisionV1["proposedBy"];
  triggerEventId?: string;
  metrics?: ComponentMetricSnapshotV1;
  reconstructed?: boolean;
}

export interface StateGraphTransitionV1 {
  from: string;
  action: string;
  to: string;
}

export interface StateGraphModelV1 {
  version: 1;
  kind: "state_graph_model";
  id: string;
  label: string;
  initialState: string;
  states: Record<string, JsonValue>;
  transitions: StateGraphTransitionV1[];
  goalStates: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReplayRecordV1 {
  version: 1;
  kind: "replay_record";
  id: string;
  modelId: string;
  fromState: string;
  action: string;
  predictedState: string;
  actualObservationHash: string;
  matched: boolean;
  occurredAt: string;
}

export interface ToolCalledData extends JsonObject {
  toolName: string;
  classification: ToolClassification;
  classifier: string;
  inputHash: string;
}

export interface ToolCompletedData extends JsonObject {
  toolName: string;
  classification: ToolClassification;
  classifier: string;
  success: boolean;
  inputHash: string;
  resultHash: string;
  mutationEpoch?: number;
  evidence?: VerificationEvidenceV1 & JsonObject;
  transition?: TransitionV1 & JsonObject;
}

export type RunEventKind =
  | "run_started"
  | "session_lineage"
  | "turn_started"
  | "turn_finished"
  | "tool_called"
  | "tool_completed"
  | "verification_waived"
  | "stop_decided"
  | "retry_started"
  | "retry_finished"
  | "hypothesis_changed"
  | "belief_changed"
  | "component_changed"
  | "executable_model_changed"
  | "refiner_started"
  | "refiner_finished"
  | "extension_error"
  | "run_finished";

interface RunEventBaseV1<K extends RunEventKind, D extends JsonObject> {
  version: 1;
  eventId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  kind: K;
  sessionRef?: string;
  turnId?: string;
  toolCallId?: string;
  parentEventId?: string;
  model?: ModelRefV1;
  status: "started" | "ok" | "error" | "blocked" | "waived";
  inputHash?: string;
  outputHash?: string;
  durationMs?: number;
  data: D;
}

export type RunEventV1 =
  | RunEventBaseV1<"run_started", JsonObject>
  | RunEventBaseV1<"session_lineage", JsonObject>
  | RunEventBaseV1<"turn_started", JsonObject>
  | RunEventBaseV1<"turn_finished", JsonObject>
  | RunEventBaseV1<"tool_called", ToolCalledData>
  | RunEventBaseV1<"tool_completed", ToolCompletedData>
  | RunEventBaseV1<"verification_waived", JsonObject>
  | RunEventBaseV1<"stop_decided", JsonObject>
  | RunEventBaseV1<"retry_started", JsonObject>
  | RunEventBaseV1<"retry_finished", JsonObject>
  | RunEventBaseV1<"hypothesis_changed", JsonObject>
  | RunEventBaseV1<"belief_changed", JsonObject>
  | RunEventBaseV1<"component_changed", JsonObject>
  | RunEventBaseV1<"executable_model_changed", JsonObject>
  | RunEventBaseV1<"refiner_started", JsonObject>
  | RunEventBaseV1<"refiner_finished", JsonObject>
  | RunEventBaseV1<"extension_error", JsonObject>
  | RunEventBaseV1<"run_finished", JsonObject>;

export type RunEventDraftV1 = Omit<
  RunEventV1,
  "version" | "eventId" | "runId" | "sequence" | "occurredAt"
> & {
  occurredAt?: string;
};

export interface HarnessMetricsV1 {
  actions: number;
  modelRequests?: number;
  verificationFailures: number;
  successfulVerifications: number;
  regressions: number;
  refinementProposals: number;
  acceptedRevisions: number;
  rolledBackRevisions: number;
}

export interface HarnessStateV1 {
  version: 1;
  kind: "harness_state";
  runId: string;
  sessionRef?: string;
  startedAt: string;
  finishedAt?: string;
  verification: VerificationStateV1;
  hypotheses: Record<string, HypothesisV1>;
  beliefs: BeliefStateV1;
  components: Record<string, ComponentRevisionRefV1>;
  activeComponents: Record<string, string>;
  executableModels: Record<string, StateGraphModelV1>;
  replayRecords: ReplayRecordV1[];
  metrics: HarnessMetricsV1;
  toolCounts: Record<string, { ok: number; error: number }>;
  retryCount: number;
  stopReason?: string;
  storageErrors: string[];
  policyErrors: string[];
  artifactRefs: string[];
  lastObservationRef: ObservationRefV1;
  lastProgressAction: number;
  failedToolIdentities: Record<string, number>;
  refinerRuns: number;
}

export interface RunManifestV1 {
  version: 1;
  kind: "run_manifest";
  runId: string;
  sessionRef?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  extensionVersion: string;
  model?: ModelRefV1;
  systemPromptHash: string;
  eventCount: number;
  ledgerHash: string;
  toolCounts: Record<string, { ok: number; error: number }>;
  mutationEpoch: number;
  verificationStatus: VerificationStatus;
  coveringEvidenceId?: string;
  coveringWaiverId?: string;
  hypothesisCounts: Record<HypothesisStatus, number>;
  selectedHypothesisIds: string[];
  retryCount: number;
  storageErrors: string[];
  policyErrors: string[];
  stopReason?: string;
  artifactRefs: string[];
  policyHash: string;
  metrics: HarnessMetricsV1;
  evaluation: EvaluationPolicyV1;
}

export type EvaluationModelTier = "strong" | "weak";
export type EvaluationThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type EvaluationFailureClass = "provider" | "harness" | "task";

export interface EvaluationModelV1 {
  id: string;
  tier: EvaluationModelTier;
  thinkingLevel: EvaluationThinkingLevel;
}

export interface EvaluationVerifierV1 {
  command: string;
  args: string[];
  timeoutMs: number;
  immutablePaths: string[];
}

export interface EvaluationTaskV1 {
  id: string;
  workspace: string;
  prompt: string;
  verifier: EvaluationVerifierV1;
  maxRunSeconds?: number;
}

export interface EvaluationSuiteV1 {
  version: 1;
  kind: "evaluation_suite";
  id: string;
  models: EvaluationModelV1[];
  tasks: EvaluationTaskV1[];
  conditions?: EvaluationPolicyV1["condition"][];
  repetitions?: number;
  refinerModel?: string;
}

export interface EvaluationExecutionIdentityV1 {
  executionHash: string;
  harnessHash: string;
  workspaceHash: string;
  hardeningConfigHash: string;
  ompVersionHash: string;
}

export interface EvaluationRunV1 extends EvaluationExecutionIdentityV1 {
  version: 1;
  kind: "evaluation_run";
  id: string;
  suiteId: string;
  specHash: string;
  taskId: string;
  replicate: number;
  condition: EvaluationPolicyV1["condition"];
  model: string;
  modelTier: EvaluationModelTier;
  modelThinkingLevel: EvaluationThinkingLevel;
  promptHash: string;
  startedAt: string;
  success: boolean;
  failureClass?: EvaluationFailureClass;
  actions: number;
  modelRequests: number;
  elapsedMs: number;
  verificationDefectsCaught?: number;
  falseGateInterventions?: number;
  reconstructionSucceeded?: boolean;
  storageBytes?: number;
  waivers?: number;
  regressionsAfterRefinement?: number;
  primaryInputTokens?: number;
  primaryOutputTokens?: number;
  primaryCostUsd?: number;
  processExitCode?: number;
  verifierExitCode?: number;
  errorHash?: string;
}

export interface EvaluationConditionSummaryV1 {
  runs: number;
  successes: number;
  successRate: number;
  providerFailures: number;
  harnessFailures: number;
  taskFailures: number;
  medianActions: number;
  medianModelRequests: number;
  medianElapsedMs: number;
  meanVerificationDefectsCaught?: number;
  falseGateInterventions?: number;
  meanStorageBytes?: number;
  meanPrimaryCostUsd?: number;
}

export interface EvaluationReportV1 extends EvaluationExecutionIdentityV1 {
  version: 1;
  kind: "evaluation_report";
  suiteId: string;
  specHash: string;
  generatedAt: string;
  conditions: EvaluationPolicyV1["condition"][];
  runCount: number;
  completePairs: number;
  weakModelPairs: number;
  summaries: Partial<
    Record<EvaluationPolicyV1["condition"], EvaluationConditionSummaryV1>
  >;
  runIds: string[];
}
