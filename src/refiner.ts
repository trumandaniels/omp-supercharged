import { canonicalJson, hashJson } from "./canonical.ts";
import {
  validateComponentPayload,
  type ComponentProposalInput,
} from "./components.ts";
import type {
  ComponentKind,
  ComponentRevisionV1,
  HarnessStateV1,
  JsonObject,
  RefinerPolicyV1,
  RefinerTrigger,
  RunEventV1,
} from "./types.ts";

export interface RefinerSnapshotV1 extends JsonObject {
  version: 1;
  kind: "refiner_snapshot";
  trigger: RefinerTrigger | "manual";
  verification: JsonObject;
  metrics: JsonObject;
  failedToolIdentities: JsonObject;
  beliefs: JsonObject[];
  hypotheses: JsonObject[];
  activeComponents: JsonObject[];
  recentTransitions: JsonObject[];
}

export interface RefinerProposalV1 {
  componentKind: ComponentKind;
  name: string;
  payload: ComponentProposalInput["payload"];
  rationale: string;
}

export interface RefinerModelRunner {
  modelLabel: string;
  run(
    systemPrompt: string,
    userPrompt: string,
    limits: { maxOutputTokens: number; maxRuntimeMs: number },
  ): Promise<string>;
}

const COMPONENT_KINDS: Record<ComponentKind, true> = {
  policy_overlay: true,
  skill: true,
  agent: true,
  memory: true,
};

function recordOf(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function transitionSummary(event: RunEventV1): JsonObject | undefined {
  if (
    event.kind !== "tool_completed" ||
    !event.data.transition ||
    typeof event.data.transition !== "object" ||
    Array.isArray(event.data.transition)
  )
    return undefined;
  const transition = event.data.transition as Record<string, unknown>;
  return {
    id: typeof transition.id === "string" ? transition.id : event.eventId,
    effect:
      typeof transition.effect === "string" ? transition.effect : "unknown",
    tool: event.data.toolName,
    success: event.data.success,
    classification: event.data.classification,
    inputHash: event.data.inputHash,
    resultHash: event.data.resultHash,
  };
}

export function buildRefinerSnapshot(
  state: HarnessStateV1,
  events: readonly RunEventV1[],
  activeRevisions: readonly ComponentRevisionV1[],
  trigger: RefinerTrigger | "manual",
  maxInputTokens: number,
): RefinerSnapshotV1 {
  const maxChars = maxInputTokens * 4;
  const snapshot: RefinerSnapshotV1 = {
    version: 1,
    kind: "refiner_snapshot",
    trigger,
    verification: {
      status: state.verification.status,
      mutationEpoch: state.verification.mutationEpoch,
      latestMutationEventId:
        state.verification.latestMutation?.eventId ?? "none",
    },
    metrics: state.metrics as unknown as JsonObject,
    failedToolIdentities: state.failedToolIdentities as unknown as JsonObject,
    beliefs: Object.values(state.beliefs.claims)
      .filter((claim) => claim.status !== "retired")
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(-20)
      .map((claim) => ({
        id: claim.id,
        area: claim.area,
        claim: claim.claim,
        confidence: claim.confidence,
        status: claim.status,
        freshnessEpoch: claim.freshnessEpoch,
        supportingEvidence: claim.supportingEvidence,
        contradictingEvidence: claim.contradictingEvidence,
      })),
    hypotheses: Object.values(state.hypotheses)
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(-12)
      .map((hypothesis) => ({
        id: hypothesis.id,
        mechanism: hypothesis.mechanism,
        confidence: hypothesis.confidence,
        status: hypothesis.status,
        predictions: hypothesis.predictions as unknown as JsonObject[],
      })),
    activeComponents: activeRevisions
      .filter((revision) => revision.status === "active")
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((revision) => ({
        revisionId: revision.id,
        componentKind: revision.componentKind,
        name: revision.name,
        contentHash: revision.contentHash,
        payload: revision.payload as unknown as JsonObject,
      })),
    recentTransitions: events
      .slice(-80)
      .map(transitionSummary)
      .filter((item): item is JsonObject => item !== undefined)
      .slice(-30),
  };
  while (canonicalJson(snapshot).length > maxChars) {
    if (snapshot.recentTransitions.length > 5)
      snapshot.recentTransitions.shift();
    else if (snapshot.beliefs.length > 3) snapshot.beliefs.shift();
    else if (snapshot.hypotheses.length > 2) snapshot.hypotheses.shift();
    else if (snapshot.activeComponents.length > 1)
      snapshot.activeComponents.shift();
    else
      throw new Error(
        `Refiner snapshot cannot fit within ${maxInputTokens} input tokens`,
      );
  }
  return snapshot;
}

export function parseRefinerResponse(
  raw: string,
  maxOutputTokens: number,
): RefinerProposalV1[] {
  if (raw.length > maxOutputTokens * 6)
    throw new TypeError("Refiner output exceeds the configured output ceiling");
  let candidate = raw.trim();
  if (candidate.startsWith("```")) {
    candidate = candidate
      .replace(/^```(?:json)?\s*/u, "")
      .replace(/\s*```$/u, "");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new TypeError(`Refiner did not return valid JSON: ${String(error)}`);
  }
  const envelope = recordOf(parsed, "refiner response");
  for (const key of Object.keys(envelope))
    if (key !== "proposals")
      throw new TypeError(`Refiner response contains unknown field ${key}`);
  if (!Array.isArray(envelope.proposals) || envelope.proposals.length > 4)
    throw new TypeError("Refiner response must contain at most four proposals");
  const names = new Set<string>();
  return envelope.proposals.map((item, index) => {
    const proposal = recordOf(item, `proposal[${index}]`);
    for (const key of Object.keys(proposal)) {
      if (!["componentKind", "name", "payload", "rationale"].includes(key))
        throw new TypeError(`proposal[${index}] contains unknown field ${key}`);
    }
    if (
      typeof proposal.componentKind !== "string" ||
      !Object.hasOwn(COMPONENT_KINDS, proposal.componentKind)
    )
      throw new TypeError(`proposal[${index}].componentKind is invalid`);
    if (
      typeof proposal.name !== "string" ||
      !/^[a-z][a-z0-9-]{1,63}$/.test(proposal.name)
    )
      throw new TypeError(`proposal[${index}].name is invalid`);
    const key = `${proposal.componentKind}:${proposal.name}`;
    if (names.has(key))
      throw new TypeError(`Refiner returned duplicate component ${key}`);
    names.add(key);
    if (
      typeof proposal.rationale !== "string" ||
      proposal.rationale.trim().length === 0 ||
      proposal.rationale.length > 4_000
    )
      throw new TypeError(`proposal[${index}].rationale is invalid`);
    return {
      componentKind: proposal.componentKind as ComponentKind,
      name: proposal.name,
      payload: validateComponentPayload(
        proposal.componentKind as ComponentKind,
        proposal.payload,
      ),
      rationale: proposal.rationale.trim(),
    };
  });
}

export async function runRefiner(
  runner: RefinerModelRunner,
  snapshot: RefinerSnapshotV1,
  policy: RefinerPolicyV1,
): Promise<{
  proposals: RefinerProposalV1[];
  snapshotHash: string;
  model: string;
}> {
  const systemPrompt = [
    "You are a bounded harness Refiner.",
    "Diagnose the supplied metadata-only trajectory and propose only evidence-linked component revisions.",
    "Do not execute tools, request secrets, disable verification, or assume a proposal will be accepted.",
    "Prefer reusing an active component over creating a new component.",
    'Return exactly one JSON object: {"proposals":[{"componentKind":"policy_overlay|skill|agent|memory","name":"lowercase-name","payload":{...},"rationale":"..."}]}.',
    "policy_overlay payload: {instructions}. skill payload: {description,instructions}. agent payload: {description,instructions,tools,modelRole?}; tools must be chosen from read, grep, glob, web_search. memory payload: {claim,confidence,scope,evidenceRefs}.",
  ].join("\n");
  const userPrompt = `Trigger: ${snapshot.trigger}\nTrajectory snapshot (raw prompts and tool bodies excluded):\n${canonicalJson(snapshot)}`;
  const raw = await runner.run(systemPrompt, userPrompt, {
    maxOutputTokens: policy.maxOutputTokens,
    maxRuntimeMs: policy.maxRuntimeMs,
  });
  return {
    proposals: parseRefinerResponse(raw, policy.maxOutputTokens),
    snapshotHash: hashJson(snapshot),
    model: runner.modelLabel,
  };
}

export function detectRefinerTriggers(
  previous: HarnessStateV1,
  current: HarnessStateV1,
  latestEvent: RunEventV1,
  policy: RefinerPolicyV1,
): RefinerTrigger[] {
  if (!policy.enabled || current.refinerRuns >= policy.maxRuns) return [];
  const candidates: RefinerTrigger[] = [];
  if (
    current.metrics.verificationFailures > previous.metrics.verificationFailures
  )
    candidates.push("verification_failure");
  if (
    current.metrics.successfulVerifications >
      previous.metrics.successfulVerifications &&
    current.verification.mutationEpoch > 0
  )
    candidates.push("successful_milestone");
  if (
    latestEvent.kind === "belief_changed" &&
    latestEvent.data.claim &&
    typeof latestEvent.data.claim === "object" &&
    !Array.isArray(latestEvent.data.claim)
  ) {
    if (
      (latestEvent.data.claim as Record<string, unknown>).status ===
      "contradicted"
    )
      candidates.push("belief_contradiction");
  }
  if (latestEvent.kind === "tool_completed" && !latestEvent.data.success) {
    const count = current.failedToolIdentities[latestEvent.data.inputHash] ?? 0;
    if (count === policy.repeatedFailureLimit)
      candidates.push("repeated_tool_failure");
  }
  const previousStagnation =
    previous.metrics.actions - previous.lastProgressAction;
  const currentStagnation =
    current.metrics.actions - current.lastProgressAction;
  if (
    previousStagnation < policy.stagnationActionLimit &&
    currentStagnation >= policy.stagnationActionLimit
  )
    candidates.push("budget_stagnation");
  const configured = new Set(policy.triggers);
  return candidates.filter((trigger) => configured.has(trigger));
}
