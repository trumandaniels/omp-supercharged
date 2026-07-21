import { hashJson } from "./canonical.ts";
import { hypothesisCounts, reduceEvents } from "./reducer.ts";
import type { ProjectPolicyV1, RunEventV1, RunManifestV1 } from "./types.ts";

export function deriveManifest(
  events: readonly RunEventV1[],
  ledgerHash: string,
  policy: ProjectPolicyV1,
  options: { extensionVersion: string; policyErrors?: readonly string[] } = {
    extensionVersion: "0.1.0",
  },
): RunManifestV1 {
  if (events.length === 0)
    throw new TypeError("Cannot derive a manifest from an empty ledger");
  const state = reduceEvents(events, options.policyErrors);
  const first = events[0];
  const counts = hypothesisCounts(state);
  const currentPolicyHash = hashJson(policy);
  let recordedPolicyHash =
    typeof first.data.policyHash === "string"
      ? first.data.policyHash
      : undefined;
  for (const event of events) {
    if (
      event.kind === "session_lineage" &&
      typeof event.data.policyHash === "string"
    )
      recordedPolicyHash = event.data.policyHash;
  }
  if (recordedPolicyHash !== currentPolicyHash)
    throw new TypeError(
      "Manifest policy does not match the latest policy recorded in the ledger",
    );
  const systemPromptHash = first.data.systemPromptHash;
  if (typeof systemPromptHash !== "string")
    throw new TypeError("Manifest ledger does not record a system prompt hash");
  const manifest: RunManifestV1 = {
    version: 1,
    kind: "run_manifest",
    runId: state.runId,
    startedAt: state.startedAt,
    extensionVersion: options.extensionVersion,
    systemPromptHash,
    eventCount: events.length,
    ledgerHash,
    toolCounts: state.toolCounts,
    mutationEpoch: state.verification.mutationEpoch,
    verificationStatus: state.verification.status,
    hypothesisCounts: counts,
    selectedHypothesisIds: Object.values(state.hypotheses)
      .filter((hypothesis) => hypothesis.status === "selected")
      .map((hypothesis) => hypothesis.id)
      .sort(),
    retryCount: state.retryCount,
    storageErrors: [...state.storageErrors],
    policyErrors: [...state.policyErrors],
    artifactRefs: [...state.artifactRefs].sort(),
    policyHash: currentPolicyHash,
    metrics: state.metrics,
    evaluation: policy.evaluation,
  };
  if (state.sessionRef !== undefined) manifest.sessionRef = state.sessionRef;
  if (state.finishedAt !== undefined) {
    manifest.finishedAt = state.finishedAt;
    manifest.durationMs = Math.max(
      0,
      Date.parse(state.finishedAt) - Date.parse(state.startedAt),
    );
  }
  if (first.model !== undefined) manifest.model = first.model;
  if (state.verification.coveringEvidence !== undefined)
    manifest.coveringEvidenceId = state.verification.coveringEvidence.id;
  if (state.verification.coveringWaiver !== undefined)
    manifest.coveringWaiverId = state.verification.coveringWaiver.id;
  if (state.stopReason !== undefined) manifest.stopReason = state.stopReason;
  validateManifest(manifest, events);
  return manifest;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value))
    if (!allowedKeys.has(key))
      throw new TypeError(`${context} contains unknown field ${key}`);
}

function assertRequiredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  context: string,
): void {
  for (const key of required)
    if (!(key in value)) throw new TypeError(`${context} requires ${key}`);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${field} must be a non-empty string`);
}

function assertTimestamp(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string")
    throw new TypeError(`${field} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value)
    throw new TypeError(`${field} must be an ISO timestamp`);
}

function assertHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value))
    throw new TypeError(`${field} must be a SHA-256 content hash`);
}

function assertInteger(
  value: unknown,
  field: string,
  minimum = 0,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new TypeError(`${field} must be an integer of at least ${minimum}`);
}

function assertStringList(
  value: unknown,
  field: string,
): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  for (let index = 0; index < value.length; index++)
    assertString(value[index], `${field}[${index}]`);
}

function optionalString(
  value: unknown,
  field: string,
): asserts value is string | undefined {
  if (value !== undefined) assertString(value, field);
}

function validateToolCounts(value: unknown): void {
  const counts = asRecord(value, "Manifest toolCounts");
  for (const [toolName, rawCount] of Object.entries(counts)) {
    assertString(toolName, "Manifest tool name");
    const count = asRecord(rawCount, `Manifest toolCounts.${toolName}`);
    assertExactKeys(count, ["ok", "error"], `Manifest toolCounts.${toolName}`);
    assertRequiredKeys(
      count,
      ["ok", "error"],
      `Manifest toolCounts.${toolName}`,
    );
    assertInteger(count.ok, `Manifest toolCounts.${toolName}.ok`);
    assertInteger(count.error, `Manifest toolCounts.${toolName}.error`);
  }
}

function validateHypothesisCounts(value: unknown): void {
  const counts = asRecord(value, "Manifest hypothesisCounts");
  const statuses = ["live", "falsified", "dominated", "selected", "deferred"];
  assertExactKeys(counts, statuses, "Manifest hypothesisCounts");
  assertRequiredKeys(counts, statuses, "Manifest hypothesisCounts");
  for (const status of statuses)
    assertInteger(counts[status], `Manifest hypothesisCounts.${status}`);
}

function validateMetrics(value: unknown): void {
  const metrics = asRecord(value, "Manifest metrics");
  const required = [
    "actions",
    "verificationFailures",
    "successfulVerifications",
    "regressions",
    "refinementProposals",
    "acceptedRevisions",
    "rolledBackRevisions",
  ];
  assertExactKeys(metrics, [...required, "modelRequests"], "Manifest metrics");
  assertRequiredKeys(metrics, required, "Manifest metrics");
  for (const field of required)
    assertInteger(metrics[field], `Manifest metrics.${field}`);
  if (metrics.modelRequests !== undefined)
    assertInteger(metrics.modelRequests, "Manifest metrics.modelRequests");
}

function validateEvaluation(value: unknown): void {
  const evaluation = asRecord(value, "Manifest evaluation");
  assertExactKeys(evaluation, ["condition", "taskId"], "Manifest evaluation");
  assertRequiredKeys(evaluation, ["condition"], "Manifest evaluation");
  if (
    evaluation.condition !== "stock" &&
    evaluation.condition !== "ledger" &&
    evaluation.condition !== "state" &&
    evaluation.condition !== "refiner" &&
    evaluation.condition !== "executable_model"
  ) {
    throw new TypeError("Manifest evaluation.condition is invalid");
  }
  optionalString(evaluation.taskId, "Manifest evaluation.taskId");
}

function nestedId(value: unknown): string | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("id" in value)
  )
    return undefined;
  return typeof value.id === "string" ? value.id : undefined;
}

export function validateManifest(
  value: unknown,
  events?: readonly RunEventV1[],
): asserts value is RunManifestV1 {
  const manifest = asRecord(value, "Manifest");
  const allowed = [
    "version",
    "kind",
    "runId",
    "sessionRef",
    "startedAt",
    "finishedAt",
    "durationMs",
    "extensionVersion",
    "model",
    "systemPromptHash",
    "eventCount",
    "ledgerHash",
    "toolCounts",
    "mutationEpoch",
    "verificationStatus",
    "coveringEvidenceId",
    "coveringWaiverId",
    "hypothesisCounts",
    "selectedHypothesisIds",
    "retryCount",
    "storageErrors",
    "policyErrors",
    "stopReason",
    "artifactRefs",
    "policyHash",
    "metrics",
    "evaluation",
  ];
  const required = [
    "version",
    "kind",
    "runId",
    "startedAt",
    "extensionVersion",
    "systemPromptHash",
    "eventCount",
    "ledgerHash",
    "toolCounts",
    "mutationEpoch",
    "verificationStatus",
    "hypothesisCounts",
    "selectedHypothesisIds",
    "retryCount",
    "storageErrors",
    "policyErrors",
    "artifactRefs",
    "policyHash",
    "metrics",
    "evaluation",
  ];
  assertExactKeys(manifest, allowed, "Manifest");
  assertRequiredKeys(manifest, required, "Manifest");
  if (manifest.version !== 1 || manifest.kind !== "run_manifest")
    throw new TypeError("Unsupported manifest contract");
  assertString(manifest.runId, "Manifest runId");
  optionalString(manifest.sessionRef, "Manifest sessionRef");
  assertTimestamp(manifest.startedAt, "Manifest startedAt");
  assertString(manifest.extensionVersion, "Manifest extensionVersion");
  assertInteger(manifest.eventCount, "Manifest eventCount", 1);
  assertHash(manifest.ledgerHash, "Manifest ledgerHash");
  assertHash(manifest.policyHash, "Manifest policyHash");
  assertHash(manifest.systemPromptHash, "Manifest systemPromptHash");
  assertInteger(manifest.mutationEpoch, "Manifest mutationEpoch");
  if (
    manifest.verificationStatus !== "clean" &&
    manifest.verificationStatus !== "stale" &&
    manifest.verificationStatus !== "verified" &&
    manifest.verificationStatus !== "waived"
  ) {
    throw new TypeError("Manifest verificationStatus is invalid");
  }
  optionalString(manifest.coveringEvidenceId, "Manifest coveringEvidenceId");
  optionalString(manifest.coveringWaiverId, "Manifest coveringWaiverId");
  if (
    manifest.coveringEvidenceId !== undefined &&
    manifest.coveringWaiverId !== undefined
  )
    throw new TypeError(
      "Manifest cannot contain evidence and waiver coverage together",
    );
  if (
    manifest.verificationStatus === "verified" &&
    manifest.coveringEvidenceId === undefined
  )
    throw new TypeError("Verified manifest requires covering evidence");
  if (
    manifest.verificationStatus === "waived" &&
    manifest.coveringWaiverId === undefined
  )
    throw new TypeError("Waived manifest requires a covering waiver");
  if (
    (manifest.verificationStatus === "clean" ||
      manifest.verificationStatus === "stale") &&
    (manifest.coveringEvidenceId !== undefined ||
      manifest.coveringWaiverId !== undefined)
  ) {
    throw new TypeError(
      "Clean or stale manifest cannot retain covering evidence",
    );
  }
  validateToolCounts(manifest.toolCounts);
  validateHypothesisCounts(manifest.hypothesisCounts);
  assertStringList(
    manifest.selectedHypothesisIds,
    "Manifest selectedHypothesisIds",
  );
  if (
    new Set(manifest.selectedHypothesisIds).size !==
    manifest.selectedHypothesisIds.length
  )
    throw new TypeError("Manifest selectedHypothesisIds contains duplicates");
  assertInteger(manifest.retryCount, "Manifest retryCount");
  assertStringList(manifest.storageErrors, "Manifest storageErrors");
  assertStringList(manifest.policyErrors, "Manifest policyErrors");
  assertStringList(manifest.artifactRefs, "Manifest artifactRefs");
  optionalString(manifest.stopReason, "Manifest stopReason");
  validateMetrics(manifest.metrics);
  validateEvaluation(manifest.evaluation);
  if (manifest.model !== undefined) {
    const model = asRecord(manifest.model, "Manifest model");
    assertExactKeys(
      model,
      ["provider", "id", "thinkingLevel"],
      "Manifest model",
    );
    assertRequiredKeys(model, ["provider", "id"], "Manifest model");
    assertString(model.provider, "Manifest model.provider");
    assertString(model.id, "Manifest model.id");
    optionalString(model.thinkingLevel, "Manifest model.thinkingLevel");
  }
  if (manifest.finishedAt === undefined) {
    if (manifest.durationMs !== undefined)
      throw new TypeError("Manifest durationMs requires finishedAt");
  } else {
    assertTimestamp(manifest.finishedAt, "Manifest finishedAt");
    if (
      typeof manifest.durationMs !== "number" ||
      !Number.isFinite(manifest.durationMs) ||
      manifest.durationMs < 0
    ) {
      throw new TypeError(
        "Manifest durationMs must be a non-negative finite number",
      );
    }
    const expectedDuration = Math.max(
      0,
      Date.parse(manifest.finishedAt) - Date.parse(manifest.startedAt),
    );
    if (manifest.durationMs !== expectedDuration)
      throw new TypeError("Manifest durationMs does not match its timestamps");
  }
  if (events === undefined) return;
  const runStarted = events[0];
  if (!runStarted || runStarted.kind !== "run_started")
    throw new TypeError("Manifest ledger must begin with run_started");
  if (events.length !== manifest.eventCount)
    throw new TypeError("Manifest eventCount does not match ledger");
  if (events.some((event) => event.runId !== manifest.runId))
    throw new TypeError("Manifest runId does not match every ledger event");
  if (runStarted.occurredAt !== manifest.startedAt)
    throw new TypeError("Manifest startedAt does not match the ledger");
  if (runStarted.sessionRef !== manifest.sessionRef)
    throw new TypeError("Manifest sessionRef does not match run_started");
  if (runStarted.data.extensionVersion !== manifest.extensionVersion)
    throw new TypeError("Manifest extensionVersion does not match run_started");
  if (runStarted.data.systemPromptHash !== manifest.systemPromptHash)
    throw new TypeError("Manifest systemPromptHash does not match run_started");
  const manifestEvaluation = asRecord(
    manifest.evaluation,
    "Manifest evaluation",
  );
  if (
    runStarted.data.evaluationCondition !== manifestEvaluation.condition ||
    runStarted.data.taskId !== manifestEvaluation.taskId
  ) {
    throw new TypeError("Manifest evaluation does not match run_started");
  }
  if ((runStarted.model === undefined) !== (manifest.model === undefined))
    throw new TypeError("Manifest model does not match run_started");
  if (
    runStarted.model !== undefined &&
    hashJson(runStarted.model) !== hashJson(manifest.model)
  )
    throw new TypeError("Manifest model does not match run_started");
  const finalEvent = events.at(-1);
  const ledgerFinishedAt =
    finalEvent?.kind === "run_finished" ? finalEvent.occurredAt : undefined;
  if (manifest.finishedAt !== ledgerFinishedAt)
    throw new TypeError(
      "Manifest finishedAt does not match the final ledger event",
    );
  const evidenceIds = new Set<string>();
  const waiverIds = new Set<string>();
  const hypothesisIds = new Set<string>();
  let recordedPolicyHash: string | undefined;
  for (const event of events) {
    if (
      (event.kind === "run_started" || event.kind === "session_lineage") &&
      typeof event.data.policyHash === "string"
    )
      recordedPolicyHash = event.data.policyHash;
    if (event.kind === "tool_completed") {
      const id = nestedId(event.data.evidence);
      if (id) evidenceIds.add(id);
    }
    if (event.kind === "verification_waived") {
      const id = nestedId(event.data.waiver);
      if (id) waiverIds.add(id);
    }
    if (event.kind === "hypothesis_changed") {
      const id = nestedId(event.data.hypothesis);
      if (id) hypothesisIds.add(id);
    }
  }
  if (recordedPolicyHash !== manifest.policyHash)
    throw new TypeError(
      "Manifest policyHash does not match the latest ledger policy",
    );
  if (
    manifest.coveringEvidenceId !== undefined &&
    !evidenceIds.has(manifest.coveringEvidenceId)
  )
    throw new TypeError("Manifest references missing evidence");
  if (
    manifest.coveringWaiverId !== undefined &&
    !waiverIds.has(manifest.coveringWaiverId)
  )
    throw new TypeError("Manifest references missing waiver");
  for (const id of manifest.selectedHypothesisIds)
    if (!hypothesisIds.has(id))
      throw new TypeError(
        `Manifest references missing selected hypothesis ${id}`,
      );
}
