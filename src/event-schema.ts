import type { RunEventKind, RunEventV1 } from "./types.ts";

const EVENT_KINDS: Record<RunEventKind, true> = {
  run_started: true,
  session_lineage: true,
  turn_started: true,
  turn_finished: true,
  tool_called: true,
  tool_completed: true,
  verification_waived: true,
  stop_decided: true,
  retry_started: true,
  retry_finished: true,
  hypothesis_changed: true,
  belief_changed: true,
  component_changed: true,
  executable_model_changed: true,
  refiner_started: true,
  refiner_finished: true,
  extension_error: true,
  run_finished: true,
};

const ENVELOPE_KEYS: Record<string, true> = {
  version: true,
  eventId: true,
  runId: true,
  sequence: true,
  occurredAt: true,
  kind: true,
  sessionRef: true,
  turnId: true,
  toolCallId: true,
  parentEventId: true,
  model: true,
  status: true,
  inputHash: true,
  outputHash: true,
  durationMs: true,
  data: true,
};

const DATA_KEYS: Record<RunEventKind, Record<string, true>> = {
  run_started: {
    extensionVersion: true,
    cwdHash: true,
    policyHash: true,
    systemPromptHash: true,
    evaluationCondition: true,
    taskId: true,
  },
  session_lineage: {
    reason: true,
    previousSessionHash: true,
    oldLeafId: true,
    newLeafId: true,
    invalidatesVerification: true,
    policyHash: true,
  },
  turn_started: { turnIndex: true },
  turn_finished: { turnIndex: true, toolResultCount: true },
  tool_called: {
    toolName: true,
    classification: true,
    classifier: true,
    inputHash: true,
  },
  tool_completed: {
    toolName: true,
    classification: true,
    classifier: true,
    success: true,
    inputHash: true,
    resultHash: true,
    mutationEpoch: true,
    evidence: true,
    transition: true,
  },
  verification_waived: { waiver: true },
  stop_decided: {
    decision: true,
    mutationEpoch: true,
    reason: true,
    continuation: true,
  },
  retry_started: { eventClass: true, attempt: true, delayMs: true },
  retry_finished: { eventClass: true, attempt: true, success: true },
  hypothesis_changed: { operation: true, hypothesis: true },
  belief_changed: { operation: true, claim: true },
  component_changed: {
    revisionId: true,
    componentKind: true,
    name: true,
    lifecycle: true,
    contentHash: true,
    parentRevisionId: true,
    validators: true,
    validationErrors: true,
    proposedBy: true,
    triggerEventId: true,
    metrics: true,
    reconstructed: true,
  },
  executable_model_changed: {
    operation: true,
    modelId: true,
    contentHash: true,
    replay: true,
  },
  refiner_started: {
    trigger: true,
    runNumber: true,
    snapshotHash: true,
    model: true,
  },
  refiner_finished: {
    trigger: true,
    runNumber: true,
    proposalCount: true,
    activatedCount: true,
    error: true,
  },
  extension_error: { scope: true, message: true },
  run_finished: { reason: true },
};

const DATA_REQUIRED: Record<RunEventKind, readonly string[]> = {
  run_started: [
    "extensionVersion",
    "cwdHash",
    "policyHash",
    "systemPromptHash",
    "evaluationCondition",
  ],
  session_lineage: ["reason", "invalidatesVerification", "policyHash"],
  turn_started: ["turnIndex"],
  turn_finished: ["turnIndex", "toolResultCount"],
  tool_called: ["toolName", "classification", "classifier", "inputHash"],
  tool_completed: [
    "toolName",
    "classification",
    "classifier",
    "success",
    "inputHash",
    "resultHash",
  ],
  verification_waived: ["waiver"],
  stop_decided: ["decision", "mutationEpoch", "reason", "continuation"],
  retry_started: ["eventClass", "attempt", "delayMs"],
  retry_finished: ["eventClass", "attempt", "success"],
  hypothesis_changed: ["operation", "hypothesis"],
  belief_changed: ["operation", "claim"],
  component_changed: [
    "revisionId",
    "componentKind",
    "name",
    "lifecycle",
    "contentHash",
    "validators",
    "validationErrors",
    "proposedBy",
  ],
  executable_model_changed: ["operation", "modelId", "contentHash"],
  refiner_started: ["trigger", "runNumber", "snapshotHash", "model"],
  refiner_finished: ["trigger", "runNumber", "proposalCount", "activatedCount"],
  extension_error: ["scope", "message"],
  run_finished: ["reason"],
};

const STATUS_BY_KIND: Record<RunEventKind, readonly string[]> = {
  run_started: ["started"],
  session_lineage: ["ok"],
  turn_started: ["started"],
  turn_finished: ["ok"],
  tool_called: ["started"],
  tool_completed: ["ok", "error"],
  verification_waived: ["waived"],
  stop_decided: ["ok", "error", "blocked"],
  retry_started: ["started"],
  retry_finished: ["ok", "error"],
  hypothesis_changed: ["ok"],
  belief_changed: ["ok"],
  component_changed: ["ok", "error", "blocked"],
  executable_model_changed: ["ok", "error"],
  refiner_started: ["started"],
  refiner_finished: ["ok", "error"],
  extension_error: ["error"],
  run_finished: ["ok", "error"],
};

const CLASSIFICATIONS: Record<string, true> = {
  mutation: true,
  verification: true,
  read: true,
  ignored: true,
  unknown: true,
};
const STATUSES: Record<string, true> = {
  started: true,
  ok: true,
  error: true,
  blocked: true,
  waived: true,
};

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: Record<string, true>,
  context: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed[key])
      throw new TypeError(`${context} contains unknown field ${key}`);
  }
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string")
    throw new TypeError(`${field} must be a string when present`);
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function assertRequiredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  context: string,
): void {
  for (const key of required) {
    if (!(key in value)) throw new TypeError(`${context} requires ${key}`);
  }
}

function assertContract(
  value: unknown,
  allowed: Record<string, true>,
  required: readonly string[],
  context: string,
): Record<string, unknown> {
  const object = asObject(value, context);
  assertExactKeys(object, allowed, context);
  assertRequiredKeys(object, required, context);
  return object;
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${field} must be a non-empty string`);
}

function assertEnum(
  value: unknown,
  allowed: readonly string[],
  field: string,
): asserts value is string {
  assertString(value, field);
  if (!allowed.includes(value)) throw new TypeError(`${field} is invalid`);
}

function assertBoolean(
  value: unknown,
  field: string,
): asserts value is boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${field} must be boolean`);
}

function assertInteger(
  value: unknown,
  field: string,
  minimum = 0,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new TypeError(`${field} must be an integer of at least ${minimum}`);
}

function assertUnitInterval(
  value: unknown,
  field: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new TypeError(`${field} must be a finite number between 0 and 1`);
  }
}

function assertTimestamp(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    throw new TypeError(`${field} must be an ISO timestamp`);
}

function assertHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value))
    throw new TypeError(`${field} must be a SHA-256 content hash`);
}

function assertStringArray(
  value: unknown,
  field: string,
): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  for (let index = 0; index < value.length; index++)
    assertString(value[index], `${field}[${index}]`);
}

function validateEvidenceReference(value: unknown, context: string): void {
  const evidence = assertContract(
    value,
    { kind: true, ref: true, note: true },
    ["kind", "ref"],
    context,
  );
  assertEnum(
    evidence.kind,
    ["run_event", "tool_call", "artifact", "unverified_note"],
    `${context}.kind`,
  );
  assertString(evidence.ref, `${context}.ref`);
  assertOptionalString(evidence.note, `${context}.note`);
  if (evidence.kind === "unverified_note")
    assertString(evidence.note, `${context}.note`);
}

function validateVerificationEvidence(value: unknown, context: string): void {
  const evidence = assertContract(
    value,
    {
      version: true,
      kind: true,
      id: true,
      mutationEpoch: true,
      toolCallId: true,
      classifier: true,
      commandIdentityHash: true,
      resultHash: true,
      observedAt: true,
      success: true,
      label: true,
    },
    [
      "version",
      "kind",
      "id",
      "mutationEpoch",
      "toolCallId",
      "classifier",
      "commandIdentityHash",
      "resultHash",
      "observedAt",
      "success",
    ],
    context,
  );
  if (
    evidence.version !== 1 ||
    evidence.kind !== "verification_evidence" ||
    evidence.success !== true
  )
    throw new TypeError(`${context} has an invalid contract`);
  assertString(evidence.id, `${context}.id`);
  assertInteger(evidence.mutationEpoch, `${context}.mutationEpoch`);
  assertString(evidence.toolCallId, `${context}.toolCallId`);
  assertString(evidence.classifier, `${context}.classifier`);
  assertHash(evidence.commandIdentityHash, `${context}.commandIdentityHash`);
  assertHash(evidence.resultHash, `${context}.resultHash`);
  assertTimestamp(evidence.observedAt, `${context}.observedAt`);
  assertOptionalString(evidence.label, `${context}.label`);
}

function validateWaiver(value: unknown, context: string): void {
  const waiver = assertContract(
    value,
    {
      version: true,
      kind: true,
      id: true,
      mutationEpoch: true,
      reason: true,
      observedAt: true,
    },
    ["version", "kind", "id", "mutationEpoch", "reason", "observedAt"],
    context,
  );
  if (waiver.version !== 1 || waiver.kind !== "verification_waiver")
    throw new TypeError(`${context} has an invalid contract`);
  assertString(waiver.id, `${context}.id`);
  assertInteger(waiver.mutationEpoch, `${context}.mutationEpoch`);
  assertString(waiver.reason, `${context}.reason`);
  assertTimestamp(waiver.observedAt, `${context}.observedAt`);
}

function validateObservation(value: unknown, context: string): void {
  const observation = assertContract(
    value,
    { version: true, kind: true, source: true, ref: true, hash: true },
    ["version", "kind", "source", "ref"],
    context,
  );
  if (observation.version !== 1 || observation.kind !== "observation_ref")
    throw new TypeError(`${context} has an invalid contract`);
  assertEnum(
    observation.source,
    ["run", "session", "tool", "artifact"],
    `${context}.source`,
  );
  assertString(observation.ref, `${context}.ref`);
  if (observation.hash !== undefined)
    assertHash(observation.hash, `${context}.hash`);
}

function validateTransition(value: unknown, context: string): void {
  const transition = assertContract(
    value,
    {
      version: true,
      kind: true,
      id: true,
      observationBefore: true,
      action: true,
      observationAfter: true,
      effect: true,
      budgetDelta: true,
      evidenceRefs: true,
      occurredAt: true,
    },
    [
      "version",
      "kind",
      "id",
      "observationBefore",
      "action",
      "observationAfter",
      "effect",
      "budgetDelta",
      "evidenceRefs",
      "occurredAt",
    ],
    context,
  );
  if (transition.version !== 1 || transition.kind !== "transition")
    throw new TypeError(`${context} has an invalid contract`);
  assertString(transition.id, `${context}.id`);
  validateObservation(
    transition.observationBefore,
    `${context}.observationBefore`,
  );
  validateObservation(
    transition.observationAfter,
    `${context}.observationAfter`,
  );
  const action = assertContract(
    transition.action,
    { version: true, kind: true, tool: true, identityHash: true, label: true },
    ["version", "kind", "tool", "identityHash"],
    `${context}.action`,
  );
  if (action.version !== 1 || action.kind !== "action")
    throw new TypeError(`${context}.action has an invalid contract`);
  assertString(action.tool, `${context}.action.tool`);
  assertHash(action.identityHash, `${context}.action.identityHash`);
  assertOptionalString(action.label, `${context}.action.label`);
  assertEnum(
    transition.effect,
    ["progress", "no_progress", "regression", "terminal", "unknown"],
    `${context}.effect`,
  );
  const budget = assertContract(
    transition.budgetDelta,
    { actions: true, modelRequests: true, elapsedMs: true },
    [],
    `${context}.budgetDelta`,
  );
  for (const [key, amount] of Object.entries(budget))
    assertInteger(amount, `${context}.budgetDelta.${key}`);
  assertStringArray(transition.evidenceRefs, `${context}.evidenceRefs`);
  assertTimestamp(transition.occurredAt, `${context}.occurredAt`);
}

function validateHypothesis(value: unknown, context: string): void {
  const hypothesis = assertContract(
    value,
    {
      version: true,
      kind: true,
      id: true,
      mechanism: true,
      evidenceFor: true,
      evidenceAgainst: true,
      predictions: true,
      falsificationTest: true,
      confidence: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
    [
      "version",
      "kind",
      "id",
      "mechanism",
      "evidenceFor",
      "evidenceAgainst",
      "predictions",
      "confidence",
      "status",
      "createdAt",
      "updatedAt",
    ],
    context,
  );
  if (hypothesis.version !== 1 || hypothesis.kind !== "hypothesis")
    throw new TypeError(`${context} has an invalid contract`);
  assertString(hypothesis.id, `${context}.id`);
  assertString(hypothesis.mechanism, `${context}.mechanism`);
  for (const field of ["evidenceFor", "evidenceAgainst"] as const) {
    if (!Array.isArray(hypothesis[field]))
      throw new TypeError(`${context}.${field} must be an array`);
    hypothesis[field].forEach((item, index) =>
      validateEvidenceReference(item, `${context}.${field}[${index}]`),
    );
  }
  if (!Array.isArray(hypothesis.predictions))
    throw new TypeError(`${context}.predictions must be an array`);
  hypothesis.predictions.forEach((item, index) => {
    const prediction = assertContract(
      item,
      { id: true, description: true, observable: true },
      ["id", "description", "observable"],
      `${context}.predictions[${index}]`,
    );
    assertString(prediction.id, `${context}.predictions[${index}].id`);
    assertString(
      prediction.description,
      `${context}.predictions[${index}].description`,
    );
    assertString(
      prediction.observable,
      `${context}.predictions[${index}].observable`,
    );
  });
  if (hypothesis.falsificationTest !== undefined) {
    const test = assertContract(
      hypothesis.falsificationTest,
      { description: true, estimatedCost: true, risk: true },
      ["description"],
      `${context}.falsificationTest`,
    );
    assertString(test.description, `${context}.falsificationTest.description`);
    if (test.risk !== undefined)
      assertEnum(
        test.risk,
        ["read-only", "reversible", "irreversible"],
        `${context}.falsificationTest.risk`,
      );
    if (test.estimatedCost !== undefined) {
      const estimatedCost = asObject(
        test.estimatedCost,
        `${context}.falsificationTest.estimatedCost`,
      );
      for (const [key, amount] of Object.entries(estimatedCost)) {
        assertString(key, `${context}.falsificationTest.estimatedCost key`);
        if (
          typeof amount !== "number" ||
          !Number.isFinite(amount) ||
          amount < 0
        ) {
          throw new TypeError(
            `${context}.falsificationTest.estimatedCost.${key} must be non-negative`,
          );
        }
      }
    }
  }
  assertUnitInterval(hypothesis.confidence, `${context}.confidence`);
  assertEnum(
    hypothesis.status,
    ["live", "falsified", "dominated", "selected", "deferred"],
    `${context}.status`,
  );
  assertTimestamp(hypothesis.createdAt, `${context}.createdAt`);
  assertTimestamp(hypothesis.updatedAt, `${context}.updatedAt`);
}

function validateBeliefClaim(value: unknown, context: string): void {
  const claim = assertContract(
    value,
    {
      version: true,
      kind: true,
      id: true,
      area: true,
      claim: true,
      confidence: true,
      scope: true,
      supportingEvidence: true,
      contradictingEvidence: true,
      freshnessEpoch: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
    [
      "version",
      "kind",
      "id",
      "area",
      "claim",
      "confidence",
      "scope",
      "supportingEvidence",
      "contradictingEvidence",
      "freshnessEpoch",
      "status",
      "createdAt",
      "updatedAt",
    ],
    context,
  );
  if (claim.version !== 1 || claim.kind !== "belief_claim")
    throw new TypeError(`${context} has an invalid contract`);
  assertString(claim.id, `${context}.id`);
  assertEnum(
    claim.area,
    [
      "world_model",
      "goal_model",
      "action_model",
      "recent_finding",
      "open_question",
      "current_plan",
      "cross_task_knowledge",
    ],
    `${context}.area`,
  );
  assertString(claim.claim, `${context}.claim`);
  assertUnitInterval(claim.confidence, `${context}.confidence`);
  assertString(claim.scope, `${context}.scope`);
  assertStringArray(claim.supportingEvidence, `${context}.supportingEvidence`);
  assertStringArray(
    claim.contradictingEvidence,
    `${context}.contradictingEvidence`,
  );
  assertInteger(claim.freshnessEpoch, `${context}.freshnessEpoch`);
  assertEnum(
    claim.status,
    ["active", "contradicted", "retired"],
    `${context}.status`,
  );
  assertTimestamp(claim.createdAt, `${context}.createdAt`);
  assertTimestamp(claim.updatedAt, `${context}.updatedAt`);
}

function validateReplay(value: unknown, context: string): void {
  const replay = assertContract(
    value,
    {
      version: true,
      kind: true,
      id: true,
      modelId: true,
      fromState: true,
      action: true,
      predictedState: true,
      actualObservationHash: true,
      matched: true,
      occurredAt: true,
    },
    [
      "version",
      "kind",
      "id",
      "modelId",
      "fromState",
      "action",
      "predictedState",
      "actualObservationHash",
      "matched",
      "occurredAt",
    ],
    context,
  );
  if (replay.version !== 1 || replay.kind !== "replay_record")
    throw new TypeError(`${context} has an invalid contract`);
  for (const field of [
    "id",
    "modelId",
    "fromState",
    "action",
    "predictedState",
  ] as const)
    assertString(replay[field], `${context}.${field}`);
  assertHash(replay.actualObservationHash, `${context}.actualObservationHash`);
  assertBoolean(replay.matched, `${context}.matched`);
  assertTimestamp(replay.occurredAt, `${context}.occurredAt`);
}

function validateComponentMetrics(value: unknown, context: string): void {
  const metrics = assertContract(
    value,
    {
      actions: true,
      verificationFailures: true,
      regressions: true,
      successfulVerifications: true,
    },
    [
      "actions",
      "verificationFailures",
      "regressions",
      "successfulVerifications",
    ],
    context,
  );
  for (const [key, amount] of Object.entries(metrics))
    assertInteger(amount, `${context}.${key}`);
}

function validateRunEventData(
  kind: RunEventKind,
  data: Record<string, unknown>,
  event: Record<string, unknown>,
): void {
  assertRequiredKeys(data, DATA_REQUIRED[kind], `${kind} data`);
  if (!STATUS_BY_KIND[kind].includes(event.status as string))
    throw new TypeError(`${kind} has invalid status ${String(event.status)}`);
  switch (kind) {
    case "run_started":
      assertString(data.extensionVersion, "run_started.extensionVersion");
      assertHash(data.cwdHash, "run_started.cwdHash");
      assertHash(data.policyHash, "run_started.policyHash");
      assertHash(data.systemPromptHash, "run_started.systemPromptHash");
      assertEnum(
        data.evaluationCondition,
        ["stock", "ledger", "state", "refiner", "executable_model"],
        "run_started.evaluationCondition",
      );
      assertOptionalString(data.taskId, "run_started.taskId");
      break;
    case "session_lineage":
      assertEnum(
        data.reason,
        ["switch", "branch", "tree"],
        "session_lineage.reason",
      );
      if (data.invalidatesVerification !== true)
        throw new TypeError("session_lineage must invalidate verification");
      assertHash(data.policyHash, "session_lineage.policyHash");
      assertOptionalString(
        data.previousSessionHash,
        "session_lineage.previousSessionHash",
      );
      assertOptionalString(data.oldLeafId, "session_lineage.oldLeafId");
      assertOptionalString(data.newLeafId, "session_lineage.newLeafId");
      if (data.reason === "tree") {
        assertString(data.oldLeafId, "session_lineage.oldLeafId");
        assertString(data.newLeafId, "session_lineage.newLeafId");
      } else {
        assertString(
          data.previousSessionHash,
          "session_lineage.previousSessionHash",
        );
      }
      break;
    case "turn_started":
      assertInteger(data.turnIndex, "turn_started.turnIndex");
      break;
    case "turn_finished":
      assertInteger(data.turnIndex, "turn_finished.turnIndex");
      assertInteger(data.toolResultCount, "turn_finished.toolResultCount");
      break;
    case "tool_called":
    case "tool_completed":
      assertString(data.toolName, `${kind}.toolName`);
      assertEnum(
        data.classification,
        Object.keys(CLASSIFICATIONS),
        `${kind}.classification`,
      );
      assertString(data.classifier, `${kind}.classifier`);
      assertHash(data.inputHash, `${kind}.inputHash`);
      if (kind === "tool_completed") {
        assertBoolean(data.success, "tool_completed.success");
        assertHash(data.resultHash, "tool_completed.resultHash");
        if ((data.success === true) !== (event.status === "ok"))
          throw new TypeError("tool_completed status must match success");
        if (data.mutationEpoch !== undefined)
          assertInteger(data.mutationEpoch, "tool_completed.mutationEpoch", 1);
        if (data.evidence !== undefined)
          validateVerificationEvidence(
            data.evidence,
            "tool_completed.evidence",
          );
        if (data.transition !== undefined)
          validateTransition(data.transition, "tool_completed.transition");
      }
      break;
    case "verification_waived":
      validateWaiver(data.waiver, "verification_waived.waiver");
      break;
    case "stop_decided": {
      assertEnum(
        data.decision,
        ["permit", "continue", "block", "permit_at_ceiling"],
        "stop_decided.decision",
      );
      assertInteger(data.mutationEpoch, "stop_decided.mutationEpoch");
      assertString(data.reason, "stop_decided.reason");
      assertBoolean(data.continuation, "stop_decided.continuation");
      const expected =
        data.decision === "permit"
          ? ["ok", false]
          : data.decision === "permit_at_ceiling"
            ? ["error", false]
            : ["blocked", true];
      if (event.status !== expected[0] || data.continuation !== expected[1])
        throw new TypeError(
          "stop_decided status or continuation is inconsistent",
        );
      break;
    }
    case "retry_started":
      assertString(data.eventClass, "retry_started.eventClass");
      assertInteger(data.attempt, "retry_started.attempt", 1);
      assertInteger(data.delayMs, "retry_started.delayMs");
      break;
    case "retry_finished":
      assertString(data.eventClass, "retry_finished.eventClass");
      assertInteger(data.attempt, "retry_finished.attempt", 1);
      assertBoolean(data.success, "retry_finished.success");
      if ((data.success === true) !== (event.status === "ok"))
        throw new TypeError("retry_finished status must match success");
      break;
    case "hypothesis_changed":
      assertString(data.operation, "hypothesis_changed.operation");
      validateHypothesis(data.hypothesis, "hypothesis_changed.hypothesis");
      break;
    case "belief_changed":
      assertString(data.operation, "belief_changed.operation");
      validateBeliefClaim(data.claim, "belief_changed.claim");
      break;
    case "component_changed":
      assertString(data.revisionId, "component_changed.revisionId");
      assertEnum(
        data.componentKind,
        ["policy_overlay", "skill", "agent", "memory"],
        "component_changed.componentKind",
      );
      assertString(data.name, "component_changed.name");
      assertEnum(
        data.lifecycle,
        [
          "proposed",
          "schema_valid",
          "policy_valid",
          "canary_valid",
          "active",
          "rejected",
          "rolled_back",
        ],
        "component_changed.lifecycle",
      );
      assertHash(data.contentHash, "component_changed.contentHash");
      assertOptionalString(
        data.parentRevisionId,
        "component_changed.parentRevisionId",
      );
      assertStringArray(data.validators, "component_changed.validators");
      assertStringArray(
        data.validationErrors,
        "component_changed.validationErrors",
      );
      assertEnum(
        data.proposedBy,
        ["user", "model", "refiner"],
        "component_changed.proposedBy",
      );
      assertOptionalString(
        data.triggerEventId,
        "component_changed.triggerEventId",
      );
      if (data.metrics !== undefined)
        validateComponentMetrics(data.metrics, "component_changed.metrics");
      if (data.reconstructed !== undefined)
        assertBoolean(data.reconstructed, "component_changed.reconstructed");
      break;
    case "executable_model_changed":
      assertEnum(
        data.operation,
        ["register", "simplify", "replay", "reconstructed"],
        "executable_model_changed.operation",
      );
      assertString(data.modelId, "executable_model_changed.modelId");
      assertHash(data.contentHash, "executable_model_changed.contentHash");
      if (data.operation === "replay")
        validateReplay(data.replay, "executable_model_changed.replay");
      else if (data.replay !== undefined)
        throw new TypeError("Only replay events may contain replay data");
      break;
    case "refiner_started":
      assertEnum(
        data.trigger,
        [
          "manual",
          "verification_failure",
          "repeated_tool_failure",
          "budget_stagnation",
          "successful_milestone",
          "belief_contradiction",
        ],
        "refiner_started.trigger",
      );
      assertInteger(data.runNumber, "refiner_started.runNumber", 1);
      assertHash(data.snapshotHash, "refiner_started.snapshotHash");
      assertString(data.model, "refiner_started.model");
      break;
    case "refiner_finished":
      assertEnum(
        data.trigger,
        [
          "manual",
          "verification_failure",
          "repeated_tool_failure",
          "budget_stagnation",
          "successful_milestone",
          "belief_contradiction",
        ],
        "refiner_finished.trigger",
      );
      assertInteger(data.runNumber, "refiner_finished.runNumber", 1);
      assertInteger(data.proposalCount, "refiner_finished.proposalCount");
      assertInteger(data.activatedCount, "refiner_finished.activatedCount");
      assertOptionalString(data.error, "refiner_finished.error");
      if (event.status === "error")
        assertString(data.error, "refiner_finished.error");
      break;
    case "extension_error":
      assertString(data.scope, "extension_error.scope");
      assertString(data.message, "extension_error.message");
      break;
    case "run_finished":
      assertString(data.reason, "run_finished.reason");
      break;
  }
}

export function validateRunEvent(value: unknown): asserts value is RunEventV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Run event must be an object");
  const event = value as Record<string, unknown>;
  assertExactKeys(event, ENVELOPE_KEYS, "Run event");
  if (event.version !== 1) throw new TypeError("Unsupported run event version");
  assertString(event.eventId, "Run event eventId");
  assertString(event.runId, "Run event runId");
  assertInteger(event.sequence, "Run event sequence", 1);
  assertTimestamp(event.occurredAt, "Run event occurredAt");
  if (
    typeof event.kind !== "string" ||
    !EVENT_KINDS[event.kind as RunEventKind]
  )
    throw new TypeError("Unknown run event kind");
  if (typeof event.status !== "string" || !STATUSES[event.status])
    throw new TypeError("Unknown run event status");
  if (event.sessionRef !== undefined)
    assertString(event.sessionRef, "sessionRef");
  if (event.turnId !== undefined) assertString(event.turnId, "turnId");
  if (event.toolCallId !== undefined)
    assertString(event.toolCallId, "toolCallId");
  if (event.parentEventId !== undefined)
    assertString(event.parentEventId, "parentEventId");
  if (event.inputHash !== undefined) assertHash(event.inputHash, "inputHash");
  if (event.outputHash !== undefined)
    assertHash(event.outputHash, "outputHash");
  if (
    event.durationMs !== undefined &&
    (typeof event.durationMs !== "number" ||
      !Number.isFinite(event.durationMs) ||
      event.durationMs < 0)
  ) {
    throw new TypeError("durationMs must be a non-negative finite number");
  }
  if (event.model !== undefined) {
    if (
      !event.model ||
      typeof event.model !== "object" ||
      Array.isArray(event.model)
    )
      throw new TypeError("model must be an object");
    const model = event.model as Record<string, unknown>;
    assertExactKeys(
      model,
      { provider: true, id: true, thinkingLevel: true },
      "model",
    );
    assertString(model.provider, "model.provider");
    assertString(model.id, "model.id");
    assertOptionalString(model.thinkingLevel, "model.thinkingLevel");
  }
  const data = asObject(event.data, "Run event data");
  const kind = event.kind as RunEventKind;
  assertExactKeys(data, DATA_KEYS[kind], `${kind} data`);
  validateRunEventData(kind, data, event);
}
