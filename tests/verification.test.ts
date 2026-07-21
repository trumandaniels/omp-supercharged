import assert from "node:assert/strict";
import test from "node:test";
import { hashJson } from "../src/canonical.ts";
import {
  classifyShellCommand,
  classifyToolCall,
} from "../src/classification.ts";
import { validateRunEvent } from "../src/event-schema.ts";
import { deriveManifest, validateManifest } from "../src/manifest.ts";
import { DEFAULT_PROJECT_POLICY, parseProjectPolicy } from "../src/policy.ts";
import { createInitialState, decideStop, reduceEvent } from "../src/reducer.ts";
import type {
  HarnessStateV1,
  JsonObject,
  RunEventKind,
  RunEventV1,
  VerificationEvidenceV1,
  VerificationWaiverV1,
} from "../src/types.ts";

const RUN_ID = "run-verification";
const STARTED_AT = "2026-07-20T12:00:00.000Z";
let sequence = 0;

function makeEvent(
  kind: RunEventKind,
  status: RunEventV1["status"],
  data: JsonObject,
  envelope: Partial<RunEventV1> = {},
): RunEventV1 {
  sequence++;
  const event = {
    version: 1,
    eventId: `event-${sequence}`,
    runId: RUN_ID,
    sequence,
    occurredAt: new Date(
      Date.parse(STARTED_AT) + sequence * 1_000,
    ).toISOString(),
    kind,
    status,
    data,
    ...envelope,
  } as RunEventV1;
  validateRunEvent(event);
  return event;
}

function toolEvent(
  classification: "mutation" | "verification" | "unknown",
  success: boolean,
  toolCallId: string,
  extra: JsonObject = {},
): RunEventV1 {
  const inputHash = hashJson({ toolCallId, input: true });
  const resultHash = hashJson({ toolCallId, success });
  return makeEvent(
    "tool_completed",
    success ? "ok" : "error",
    {
      toolName: classification === "mutation" ? "write" : "bash",
      classification,
      classifier: `test:${classification}`,
      success,
      inputHash,
      resultHash,
      ...extra,
    },
    { toolCallId, inputHash, outputHash: resultHash },
  );
}

test("classification is conservative across shell, LSP, devices, and subagents", () => {
  const policy = structuredClone(DEFAULT_PROJECT_POLICY);
  assert.equal(
    classifyShellCommand("  omp   plugin doctor  ", policy).classification,
    "verification",
  );
  assert.equal(
    classifyShellCommand(
      "node --experimental-strip-types --test --test-concurrency=1 tests/*.test.ts",
      policy,
    ).classification,
    "verification",
  );
  assert.equal(
    classifyShellCommand("sfw-npm test", policy).classification,
    "verification",
  );
  assert.equal(
    classifyShellCommand("echo bun test", policy).classification,
    "unknown",
  );
  assert.equal(
    classifyShellCommand("git status --short", policy).classification,
    "read",
  );
  assert.equal(
    classifyToolCall({ toolName: "edit", input: {} }, policy).classification,
    "mutation",
  );
  assert.equal(
    classifyToolCall(
      { toolName: "lsp", input: { action: "rename", apply: false } },
      policy,
    ).classification,
    "read",
  );
  assert.equal(
    classifyToolCall(
      { toolName: "lsp", input: { action: "code_actions", apply: false } },
      policy,
    ).classification,
    "read",
  );
  assert.equal(
    classifyToolCall(
      {
        toolName: "write",
        input: { path: "xd://lsp", content: '{"action":"diagnostics"}' },
      },
      policy,
    ).classification,
    "read",
  );
  assert.equal(
    classifyToolCall(
      {
        toolName: "task",
        input: { tasks: [{ agent: "scout" }, { agent: "scout" }] },
      },
      policy,
    ).classification,
    "read",
  );
  assert.equal(
    classifyToolCall(
      { toolName: "task", input: { tasks: [{ agent: "reviewer" }] } },
      policy,
    ).classification,
    "mutation",
  );

  policy.verification.ignoreCommandPatterns = ["^omp plugin doctor$"];
  assert.equal(
    classifyShellCommand("omp plugin doctor", policy).classification,
    "ignored",
  );
});
test("prototype-named tools and LSP actions remain unknown", () => {
  const policy = structuredClone(DEFAULT_PROJECT_POLICY);
  assert.equal(
    classifyToolCall({ toolName: "read", input: {} }, policy).classification,
    "read",
  );
  assert.equal(
    classifyToolCall(
      { toolName: "lsp", input: { action: "diagnostics" } },
      policy,
    ).classification,
    "read",
  );
  for (const name of ["constructor", "toString", "__proto__"]) {
    const tool = classifyToolCall({ toolName: name, input: {} }, policy);
    assert.equal(tool.classification, "unknown");
    assert.equal(tool.classifier, "builtin:unknown-tool");

    const action = classifyToolCall(
      { toolName: "lsp", input: { action: name } },
      policy,
    );
    assert.equal(action.classification, "unknown");
    assert.equal(action.classifier, "builtin:unknown-lsp-action");
  }
});

test("compound shell commands cannot hide mutations behind verification", () => {
  const policy = structuredClone(DEFAULT_PROJECT_POLICY);

  assert.equal(
    classifyShellCommand("node --test test.mjs", policy).classification,
    "verification",
  );
  assert.equal(
    classifyShellCommand("git status --short", policy).classification,
    "read",
  );
  assert.equal(
    classifyShellCommand("prettier --write src/a.ts", policy).classification,
    "mutation",
  );
  assert.equal(
    classifyShellCommand(
      "node --test test.mjs && prettier --write src/a.ts",
      policy,
    ).classification,
    "mutation",
  );
  assert.equal(
    classifyShellCommand("node --test; echo x > file", policy).classification,
    "mutation",
  );
  assert.equal(
    classifyShellCommand(
      "node --test first.mjs && node --test second.mjs",
      policy,
    ).classification,
    "verification",
  );
  assert.equal(
    classifyShellCommand(
      "node --test first.mjs; node --test second.mjs",
      policy,
    ).classification,
    "verification",
  );
  assert.equal(
    classifyShellCommand(
      "node --test first.mjs | node --test second.mjs",
      policy,
    ).classification,
    "verification",
  );
  assert.equal(
    classifyShellCommand("node --test first.mjs | tee results.txt", policy)
      .classification,
    "mutation",
  );
  assert.equal(
    classifyShellCommand("node --test test.mjs > results.txt", policy)
      .classification,
    "mutation",
  );
  assert.equal(
    classifyShellCommand("node --test test.mjs &", policy).classification,
    "mutation",
  );
  assert.equal(
    classifyShellCommand("node --test $(echo test.mjs)", policy).classification,
    "mutation",
  );
  assert.equal(
    classifyShellCommand("node --test `echo test.mjs`", policy).classification,
    "mutation",
  );
  assert.equal(
    classifyShellCommand('node --test "test|name.mjs"', policy).classification,
    "verification",
  );

  policy.verification.commandPatterns = ["^custom(?:\\s|$)"];
  policy.verification.mutationCommandPatterns = ["^custom(?:\\s|$)"];
  assert.equal(
    classifyShellCommand("custom action", policy).classification,
    "mutation",
  );

  policy.verification.ignoreCommandPatterns = ["^custom(?:\\s|$)"];
  assert.equal(
    classifyShellCommand("custom action", policy).classification,
    "ignored",
  );
});

test("default policy enables every model tool without automatic activation", () => {
  const parsed = parseProjectPolicy({ version: 1 });
  assert.equal(parsed.evaluation.condition, "executable_model");
  assert.equal(parsed.refiner.enabled, true);
  assert.equal(parsed.refiner.autoActivate, false);
  assert.deepEqual(parsed.refiner.triggers, []);
});

test("policy parsing rejects partial malformed configuration atomically", () => {
  const parsed = parseProjectPolicy({
    version: 1,
    verification: { maxStopContinuations: 2 },
    refiner: { enabled: true, triggers: ["verification_failure"], maxRuns: 3 },
    evaluation: { condition: "refiner", taskId: "task-a" },
  });
  assert.equal(parsed.verification.maxStopContinuations, 2);
  assert.deepEqual(
    parsed.verification.commandPatterns,
    DEFAULT_PROJECT_POLICY.verification.commandPatterns,
  );
  assert.equal(parsed.refiner.enabled, true);
  assert.deepEqual(parsed.refiner.triggers, ["verification_failure"]);
  assert.throws(
    () =>
      parseProjectPolicy({
        version: 1,
        verification: { commandPatterns: ["pytest"] },
      }),
    /must be anchored/u,
  );
  assert.throws(
    () =>
      parseProjectPolicy({
        version: 1,
        refiner: { triggers: ["verification_failure", "verification_failure"] },
      }),
    /duplicate/u,
  );
  assert.throws(
    () =>
      parseProjectPolicy({
        version: 1,
        evaluation: { condition: "everything" },
      }),
    /invalid/u,
  );
  for (const key of ["constructor", "toString", "__proto__"]) {
    const value = JSON.parse(
      `{"version":1,${JSON.stringify(key)}:true}`,
    ) as Record<string, unknown>;
    assert.equal(Object.hasOwn(value, key), true);
    assert.throws(
      () => parseProjectPolicy(value),
      new RegExp(`unknown field ${key}`, "u"),
    );
  }
});

test("freshness transitions, bounded stop decisions, and epoch-scoped waivers remain reconstructible", () => {
  sequence = 0;
  const events: RunEventV1[] = [];
  const started = makeEvent(
    "run_started",
    "started",
    {
      extensionVersion: "0.1.0",
      cwdHash: hashJson({ cwd: "/workspace" }),
      policyHash: hashJson(DEFAULT_PROJECT_POLICY),
      systemPromptHash: hashJson(["system"]),
      evaluationCondition: DEFAULT_PROJECT_POLICY.evaluation.condition,
    },
    { sessionRef: "session-verification" },
  );
  events.push(started);
  let state: HarnessStateV1 = reduceEvent(
    createInitialState(RUN_ID, STARTED_AT),
    started,
  );

  const prematureCheck = toolEvent("verification", true, "tool-check-before");
  events.push(prematureCheck);
  state = reduceEvent(state, prematureCheck);
  assert.equal(state.verification.status, "clean");
  assert.equal(state.metrics.successfulVerifications, 1);

  const mutationOne = toolEvent("mutation", true, "tool-mutation-1", {
    mutationEpoch: 1,
  });
  events.push(mutationOne);
  state = reduceEvent(state, mutationOne);
  assert.equal(state.verification.status, "stale");
  assert.equal(state.verification.mutationEpoch, 1);
  assert.equal(decideStop(state, 1), "continue");

  const failedCheck = toolEvent("verification", false, "tool-check-failed");
  events.push(failedCheck);
  state = reduceEvent(state, failedCheck);
  assert.equal(state.verification.status, "stale");
  assert.equal(state.metrics.verificationFailures, 1);

  const continueStop = makeEvent("stop_decided", "blocked", {
    decision: "continue",
    mutationEpoch: 1,
    reason: "fresh check required",
    continuation: true,
  });
  events.push(continueStop);
  state = reduceEvent(state, continueStop);
  assert.equal(decideStop(state, 1), "block");
  const blockStop = makeEvent("stop_decided", "blocked", {
    decision: "block",
    mutationEpoch: 1,
    reason: "still stale",
    continuation: true,
  });
  events.push(blockStop);
  state = reduceEvent(state, blockStop);
  assert.equal(decideStop(state, 1), "permit_at_ceiling");

  const verificationInputHash = hashJson({
    toolCallId: "tool-check-success",
    input: true,
  });
  const verificationResultHash = hashJson({
    toolCallId: "tool-check-success",
    success: true,
  });
  const evidence: VerificationEvidenceV1 = {
    version: 1,
    kind: "verification_evidence",
    id: "evidence-1",
    mutationEpoch: 1,
    toolCallId: "tool-check-success",
    classifier: "test:verification",
    commandIdentityHash: verificationInputHash,
    resultHash: verificationResultHash,
    observedAt: "2026-07-20T12:10:00.000Z",
    success: true,
  };
  const successfulCheck = toolEvent(
    "verification",
    true,
    "tool-check-success",
    { evidence: evidence as unknown as JsonObject },
  );
  events.push(successfulCheck);
  state = reduceEvent(state, successfulCheck);
  assert.equal(state.verification.status, "verified");
  assert.equal(state.verification.coveringEvidence?.id, "evidence-1");
  assert.equal(decideStop(state, 1), "permit");

  const failedMutation = toolEvent("mutation", false, "tool-mutation-failed");
  events.push(failedMutation);
  state = reduceEvent(state, failedMutation);
  assert.equal(state.verification.status, "verified");
  assert.equal(state.verification.mutationEpoch, 1);

  const mutationTwo = toolEvent("mutation", true, "tool-mutation-2", {
    mutationEpoch: 2,
  });
  events.push(mutationTwo);
  state = reduceEvent(state, mutationTwo);
  assert.equal(state.verification.status, "stale");
  assert.equal(state.verification.coveringEvidence, undefined);

  const waiver: VerificationWaiverV1 = {
    version: 1,
    kind: "verification_waiver",
    id: "waiver-2",
    mutationEpoch: 2,
    reason: "external device unavailable",
    observedAt: "2026-07-20T12:20:00.000Z",
  };
  const waived = makeEvent("verification_waived", "waived", {
    waiver: waiver as unknown as JsonObject,
  });
  events.push(waived);
  state = reduceEvent(state, waived);
  assert.equal(state.verification.status, "waived");

  const mutationThree = toolEvent("mutation", true, "tool-mutation-3", {
    mutationEpoch: 3,
  });
  events.push(mutationThree);
  state = reduceEvent(state, mutationThree);
  assert.equal(state.verification.status, "stale");
  assert.equal(state.verification.coveringWaiver, undefined);

  const unknown = toolEvent("unknown", true, "tool-unknown");
  events.push(unknown);
  state = reduceEvent(state, unknown);
  assert.equal(state.verification.status, "stale");

  const finished = makeEvent("run_finished", "ok", { reason: "test complete" });
  events.push(finished);
  const manifest = deriveManifest(
    events,
    hashJson(events),
    DEFAULT_PROJECT_POLICY,
    { extensionVersion: "0.1.0" },
  );
  assert.equal(manifest.eventCount, events.length);
  assert.equal(manifest.mutationEpoch, 3);
  assert.equal(manifest.verificationStatus, "stale");
  assert.equal(manifest.stopReason, "test complete");
  assert.doesNotThrow(() => validateManifest(manifest, events));
  const changedPolicy = structuredClone(DEFAULT_PROJECT_POLICY);
  changedPolicy.refiner.enabled = false;
  assert.throws(
    () => deriveManifest(events, hashJson(events), changedPolicy),
    /latest policy recorded/u,
  );
  const brokenManifest = {
    ...manifest,
    verificationStatus: "verified",
    coveringEvidenceId: "missing-evidence",
  };
  assert.throws(
    () => validateManifest(brokenManifest, events),
    /missing evidence/u,
  );
});
