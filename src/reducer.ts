import { cloneJson } from "./canonical.ts";
import type {
  BeliefClaimV1,
  HarnessStateV1,
  HypothesisStatus,
  HypothesisV1,
  JsonObject,
  ObservationRefV1,
  RunEventV1,
  TransitionV1,
  VerificationEvidenceV1,
  VerificationWaiverV1,
} from "./types.ts";

export type StopDecision =
  | "permit"
  | "continue"
  | "block"
  | "permit_at_ceiling";

export function createInitialState(
  runId: string,
  startedAt: string,
  sessionRef?: string,
): HarnessStateV1 {
  return {
    version: 1,
    kind: "harness_state",
    runId,
    sessionRef,
    startedAt,
    verification: {
      version: 1,
      kind: "verification_state",
      status: "clean",
      mutationEpoch: 0,
      stopContinuations: 0,
    },
    hypotheses: {},
    beliefs: { version: 1, kind: "belief_state", claims: {} },
    components: {},
    activeComponents: {},
    executableModels: {},
    replayRecords: [],
    metrics: {
      actions: 0,
      verificationFailures: 0,
      successfulVerifications: 0,
      regressions: 0,
      refinementProposals: 0,
      acceptedRevisions: 0,
      rolledBackRevisions: 0,
    },
    toolCounts: {},
    retryCount: 0,
    storageErrors: [],
    policyErrors: [],
    artifactRefs: [],
    lastObservationRef: {
      version: 1,
      kind: "observation_ref",
      source: "run",
      ref: runId,
    },
    lastProgressAction: 0,
    failedToolIdentities: {},
    refinerRuns: 0,
  };
}

function asObject(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${context} must be an object`);
  return value as JsonObject;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${field} must be non-empty`);
  return value;
}

function validateEvidence(
  value: unknown,
  currentEpoch: number,
): VerificationEvidenceV1 {
  const evidence = asObject(
    value,
    "verification evidence",
  ) as unknown as VerificationEvidenceV1;
  if (
    evidence.version !== 1 ||
    evidence.kind !== "verification_evidence" ||
    evidence.success !== true
  )
    throw new TypeError("Invalid verification evidence contract");
  if (evidence.mutationEpoch !== currentEpoch)
    throw new TypeError(
      "Verification evidence covers the wrong mutation epoch",
    );
  requireString(evidence.id, "evidence.id");
  requireString(evidence.toolCallId, "evidence.toolCallId");
  requireString(evidence.commandIdentityHash, "evidence.commandIdentityHash");
  requireString(evidence.resultHash, "evidence.resultHash");
  return evidence;
}

function validateTransition(value: unknown): TransitionV1 {
  const transition = asObject(value, "transition") as unknown as TransitionV1;
  if (transition.version !== 1 || transition.kind !== "transition")
    throw new TypeError("Invalid transition contract");
  requireString(transition.id, "transition.id");
  if (
    !transition.observationAfter ||
    typeof transition.observationAfter.ref !== "string"
  )
    throw new TypeError("Transition requires an after observation");
  return transition;
}

function reduceToolCompleted(
  state: HarnessStateV1,
  event: Extract<RunEventV1, { kind: "tool_completed" }>,
): void {
  const data = event.data;
  state.metrics.actions++;
  const counts = state.toolCounts[data.toolName] ?? { ok: 0, error: 0 };
  if (data.success) counts.ok++;
  else counts.error++;
  state.toolCounts[data.toolName] = counts;
  if (data.transition !== undefined) {
    const transition = validateTransition(data.transition);
    state.lastObservationRef = cloneJson(transition.observationAfter);
    if (transition.effect === "progress" || transition.effect === "terminal")
      state.lastProgressAction = state.metrics.actions;
    if (transition.effect === "regression") {
      state.metrics.regressions++;
      state.lastProgressAction = state.metrics.actions;
    }
  }
  if (!data.success)
    state.failedToolIdentities[data.inputHash] =
      (state.failedToolIdentities[data.inputHash] ?? 0) + 1;
  else delete state.failedToolIdentities[data.inputHash];

  if (data.classification === "mutation" && data.success) {
    state.verification.mutationEpoch++;
    if (
      data.mutationEpoch !== undefined &&
      data.mutationEpoch !== state.verification.mutationEpoch
    ) {
      throw new TypeError("Mutation event epoch does not match reducer epoch");
    }
    state.verification.status = "stale";
    state.verification.latestMutation = {
      eventId: event.eventId,
      epoch: state.verification.mutationEpoch,
      toolCallId: event.toolCallId ?? "unknown",
      toolName: data.toolName,
      identityHash: data.inputHash,
      observedAt: event.occurredAt,
    };
    delete state.verification.coveringEvidence;
    delete state.verification.coveringWaiver;
    state.verification.stopContinuations = 0;
    return;
  }
  if (data.classification !== "verification") return;
  if (!data.success) {
    state.metrics.verificationFailures++;
    return;
  }
  state.metrics.successfulVerifications++;
  if (state.verification.status !== "stale") return;
  const evidence = validateEvidence(
    data.evidence,
    state.verification.mutationEpoch,
  );
  state.verification.status = "verified";
  state.verification.coveringEvidence = cloneJson(evidence);
  delete state.verification.coveringWaiver;
  state.verification.stopContinuations = 0;
}

function reduceWaiver(
  state: HarnessStateV1,
  event: Extract<RunEventV1, { kind: "verification_waived" }>,
): void {
  if (state.verification.status !== "stale")
    throw new TypeError("A waiver can only cover stale state");
  const waiver = asObject(
    event.data.waiver,
    "waiver",
  ) as unknown as VerificationWaiverV1;
  if (waiver.version !== 1 || waiver.kind !== "verification_waiver")
    throw new TypeError("Invalid waiver contract");
  if (waiver.mutationEpoch !== state.verification.mutationEpoch)
    throw new TypeError("Waiver covers the wrong mutation epoch");
  requireString(waiver.reason, "waiver.reason");
  state.verification.status = "waived";
  state.verification.coveringWaiver = cloneJson(waiver);
  delete state.verification.coveringEvidence;
  state.verification.stopContinuations = 0;
}

function reduceHypothesis(
  state: HarnessStateV1,
  event: Extract<RunEventV1, { kind: "hypothesis_changed" }>,
): void {
  const hypothesis = asObject(
    event.data.hypothesis,
    "hypothesis",
  ) as unknown as HypothesisV1;
  if (hypothesis.version !== 1 || hypothesis.kind !== "hypothesis")
    throw new TypeError("Invalid hypothesis contract");
  state.hypotheses[requireString(hypothesis.id, "hypothesis.id")] =
    cloneJson(hypothesis);
}

function reduceBelief(
  state: HarnessStateV1,
  event: Extract<RunEventV1, { kind: "belief_changed" }>,
): void {
  const claim = asObject(
    event.data.claim,
    "belief claim",
  ) as unknown as BeliefClaimV1;
  if (claim.version !== 1 || claim.kind !== "belief_claim")
    throw new TypeError("Invalid belief claim contract");
  state.beliefs.claims[requireString(claim.id, "claim.id")] = cloneJson(claim);
}

function reduceComponentMetadata(
  state: HarnessStateV1,
  event: Extract<RunEventV1, { kind: "component_changed" }>,
): void {
  const data = event.data;
  const revisionId = requireString(data.revisionId, "component.revisionId");
  const componentKind = requireString(data.componentKind, "component.kind");
  const name = requireString(data.name, "component.name");
  const lifecycle = requireString(data.lifecycle, "component.lifecycle");
  const key = `${componentKind}:${name}`;
  const reconstructed = data.reconstructed === true;
  if (lifecycle === "proposed" && !reconstructed)
    state.metrics.refinementProposals++;
  if (lifecycle === "active") {
    state.activeComponents[key] = revisionId;
    if (!reconstructed) state.metrics.acceptedRevisions++;
  }
  if (lifecycle === "rolled_back") {
    if (!reconstructed) state.metrics.rolledBackRevisions++;
    if (state.activeComponents[key] === revisionId)
      delete state.activeComponents[key];
    if (typeof data.parentRevisionId === "string")
      state.activeComponents[key] = data.parentRevisionId;
  }
}

export function reduceEvent(
  previous: HarnessStateV1,
  event: RunEventV1,
): HarnessStateV1 {
  const state = cloneJson(previous);
  if (event.runId !== state.runId)
    throw new TypeError("Cannot reduce an event from a different run");
  switch (event.kind) {
    case "run_started":
      state.startedAt = event.occurredAt;
      state.sessionRef = event.sessionRef;
      break;
    case "session_lineage":
      state.hypotheses = {};
      state.beliefs = { version: 1, kind: "belief_state", claims: {} };
      state.components = {};
      state.activeComponents = {};
      state.executableModels = {};
      state.replayRecords = [];
      if (event.data.invalidatesVerification === true) {
        state.verification.mutationEpoch++;
        state.verification.status = "stale";
        state.verification.latestMutation = {
          eventId: event.eventId,
          epoch: state.verification.mutationEpoch,
          toolCallId: "session-lineage",
          toolName: "session-lineage",
          identityHash: event.outputHash ?? event.eventId,
          observedAt: event.occurredAt,
        };
        delete state.verification.coveringEvidence;
        delete state.verification.coveringWaiver;
        state.verification.stopContinuations = 0;
      }
      break;
    case "tool_completed":
      reduceToolCompleted(state, event);
      break;
    case "verification_waived":
      reduceWaiver(state, event);
      break;
    case "stop_decided":
      state.stopReason =
        typeof event.data.reason === "string" ? event.data.reason : undefined;
      if (event.data.continuation === true)
        state.verification.stopContinuations++;
      break;
    case "retry_started":
      state.retryCount++;
      break;
    case "hypothesis_changed":
      reduceHypothesis(state, event);
      break;
    case "belief_changed":
      reduceBelief(state, event);
      break;
    case "component_changed":
      reduceComponentMetadata(state, event);
      break;
    case "refiner_started":
      state.refinerRuns++;
      state.metrics.modelRequests = (state.metrics.modelRequests ?? 0) + 1;
      break;
    case "extension_error": {
      const message = requireString(
        event.data.message,
        "extension error message",
      );
      if (event.data.scope === "policy") state.policyErrors.push(message);
      else state.storageErrors.push(message);
      break;
    }
    case "run_finished":
      state.finishedAt = event.occurredAt;
      state.stopReason =
        typeof event.data.reason === "string"
          ? event.data.reason
          : state.stopReason;
      break;
  }
  return state;
}

export function reduceEvents(
  events: readonly RunEventV1[],
  initialPolicyErrors: readonly string[] = [],
): HarnessStateV1 {
  if (events.length === 0)
    throw new TypeError("Cannot reduce an empty run ledger");
  const first = events[0];
  if (first.kind !== "run_started" || first.sequence !== 1)
    throw new TypeError("Ledger must begin with run_started sequence 1");
  let state = createInitialState(
    first.runId,
    first.occurredAt,
    first.sessionRef,
  );
  state.policyErrors = [...initialPolicyErrors];
  for (let index = 0; index < events.length; index++) {
    if (events[index].sequence !== index + 1)
      throw new TypeError("Ledger sequences are not contiguous");
    state = reduceEvent(state, events[index]);
  }
  return state;
}

export function decideStop(
  state: HarnessStateV1,
  maxStopContinuations: number,
): StopDecision {
  if (state.verification.status !== "stale") return "permit";
  if (state.verification.stopContinuations < maxStopContinuations)
    return "continue";
  if (state.verification.stopContinuations === maxStopContinuations)
    return "block";
  return "permit_at_ceiling";
}

export function hypothesisCounts(
  state: HarnessStateV1,
): Record<HypothesisStatus, number> {
  const counts: Record<HypothesisStatus, number> = {
    live: 0,
    falsified: 0,
    dominated: 0,
    selected: 0,
    deferred: 0,
  };
  for (const hypothesis of Object.values(state.hypotheses))
    counts[hypothesis.status]++;
  return counts;
}

export function coveringReference(state: HarnessStateV1): string | undefined {
  return (
    state.verification.coveringEvidence?.id ??
    state.verification.coveringWaiver?.id
  );
}

export function observationFromTool(
  toolCallId: string,
  resultHash: string,
): ObservationRefV1 {
  return {
    version: 1,
    kind: "observation_ref",
    source: "tool",
    ref: toolCallId,
    hash: resultHash,
  };
}
