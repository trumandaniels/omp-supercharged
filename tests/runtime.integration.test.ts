import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256Bytes } from "../src/canonical.ts";
import { validateManifest } from "../src/manifest.ts";
import { parseRefinerResponse } from "../src/refiner.ts";
import { registerHarness } from "../src/runtime.ts";
import { reduceEvents } from "../src/reducer.ts";
import type { RunEventV1 } from "../src/types.ts";

interface RegisteredTool {
  name: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

interface RegisteredCommand {
  handler: (args: string, context: FakeContext) => Promise<unknown> | unknown;
}

interface BranchEntry {
  type: "custom";
  customType: string;
  data: unknown;
}

interface FakeContext {
  cwd: string;
  hasUI: boolean;
  ui: { notify: (message: string, level?: string) => void };
  sessionManager: {
    getSessionId: () => string;
    getBranch: () => BranchEntry[];
  };
  model: { provider: string; id: string; maxTokens: number };
  modelRegistry: Record<string, never>;
  models: { resolve: (reference: string) => FakeContext["model"] | undefined };
  getSystemPrompt: () => string[];
  setTimeout: (
    handler: () => void | Promise<void>,
    milliseconds: number,
  ) => number;
  clearTimer: (timer: number) => void;
}

function chainSchema(): unknown {
  let schema: unknown;
  schema = new Proxy(
    {},
    {
      get:
        () =>
        (..._arguments: unknown[]) =>
          schema,
    },
  );
  return schema;
}

function fakeZod(): unknown {
  return new Proxy(
    {},
    {
      get:
        () =>
        (..._arguments: unknown[]) =>
          chainSchema(),
    },
  );
}

class FakeExtensionApi {
  readonly handlers = new Map<
    string,
    Array<(event: unknown, context: FakeContext) => unknown>
  >();
  readonly commands = new Map<string, RegisteredCommand>();
  readonly tools = new Map<string, RegisteredTool>();
  readonly entries: BranchEntry[] = [];
  readonly logs: Array<{ level: string; message: string; fields?: unknown }> =
    [];
  readonly refinerOptions: Array<Record<string, unknown>> = [];
  refinerResponse = '{"proposals":[]}';
  refinerPrompt?: () => Promise<void>;
  refinerAbort?: () => Promise<void> | void;
  refinerDisposeCount = 0;
  readonly zod = fakeZod();
  readonly logger = {
    info: (message: string, fields?: unknown) =>
      this.logs.push({ level: "info", message, fields }),
    warn: (message: string, fields?: unknown) =>
      this.logs.push({ level: "warning", message, fields }),
    error: (message: string, fields?: unknown) =>
      this.logs.push({ level: "error", message, fields }),
  };
  readonly pi = {
    SessionManager: { inMemory: (_cwd: string) => ({ mode: "memory" }) },
    createAgentSession: async (options: Record<string, unknown>) => {
      this.refinerOptions.push(options);
      return {
        session: {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: this.refinerResponse }],
            },
          ],
          prompt: async (_prompt: string, _options: unknown) => {
            await this.refinerPrompt?.();
          },
          abort: async () => {
            await this.refinerAbort?.();
          },
          dispose: async () => {
            this.refinerDisposeCount++;
          },
        },
      };
    },
  };

  on(
    name: string,
    handler: (event: unknown, context: FakeContext) => unknown,
  ): void {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler);
    this.handlers.set(name, handlers);
  }

  registerCommand(name: string, command: RegisteredCommand): void {
    this.commands.set(name, command);
  }

  registerTool(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  appendEntry(customType: string, data: unknown): void {
    this.entries.push({
      type: "custom",
      customType,
      data: structuredClone(data),
    });
  }

  getThinkingLevel(): string {
    return "low";
  }

  async emit(
    name: string,
    event: unknown,
    context: FakeContext,
  ): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(name) ?? []) {
      const candidate = await handler(event, context);
      if (candidate !== undefined) result = candidate;
    }
    return result;
  }
}

function makeContext(cwd: string, branch: BranchEntry[] = []): FakeContext {
  let nextTimer = 0;
  const cancelledTimers = new Set<number>();
  const model = {
    provider: "test-provider",
    id: "test-model",
    maxTokens: 16_000,
  };
  return {
    cwd,
    hasUI: false,
    ui: { notify: () => undefined },
    sessionManager: {
      getSessionId: () => "session-integration",
      getBranch: () => structuredClone(branch),
    },
    model,
    modelRegistry: {},
    models: { resolve: () => model },
    getSystemPrompt: () => ["system prompt with PRIVATE_SYSTEM_FIXTURE"],
    setTimeout: (handler) => {
      const timer = ++nextTimer;
      queueMicrotask(() => {
        if (!cancelledTimers.has(timer)) void handler();
      });
      return timer;
    },
    clearTimer: (timer) => {
      cancelledTimers.add(timer);
    },
  };
}

async function executeTool(
  api: FakeExtensionApi,
  name: string,
  input: unknown,
  context: FakeContext,
) {
  const tool = api.tools.get(name);
  assert.ok(tool, `tool ${name} is registered`);
  return tool.execute(
    `call-${name}`,
    input,
    new AbortController().signal,
    () => undefined,
    context,
  );
}

async function readOnlyRunDirectory(
  stateHome: string,
  excluded: Set<string> = new Set(),
): Promise<{ name: string; path: string }> {
  const runsRoot = join(stateHome, "omp-supercharged", "runs");
  const names = (await readdir(runsRoot)).filter((name) => !excluded.has(name));
  assert.equal(names.length, 1);
  return { name: names[0], path: join(runsRoot, names[0]) };
}

function setHarnessEnvironment(root: string): () => void {
  const previousState = process.env.XDG_STATE_HOME;
  const previousData = process.env.XDG_DATA_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_DATA_HOME = join(root, "data");
  return () => {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousData;
  };
}

test("runtime records mutation freshness, verification, redacted metadata, and a final manifest", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omp-supercharged-runtime-"));
  const restoreEnvironment = setHarnessEnvironment(root);
  t.after(async () => {
    restoreEnvironment();
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const api = new FakeExtensionApi();
  registerHarness(api as never);
  const context = makeContext(project);
  assert.deepEqual([...api.tools.keys()].sort(), [
    "belief_state",
    "executable_model",
    "harness_component",
    "hypothesis_portfolio",
  ]);
  assert.ok(api.commands.has("harness-status"));
  await api.emit("session_start", { type: "session_start" }, context);
  for (const toolName of [
    "hypothesis_portfolio",
    "belief_state",
    "harness_component",
    "executable_model",
  ]) {
    const result = await executeTool(
      api,
      toolName,
      { operation: "list" },
      context,
    );
    assert.notEqual(result.isError, true, `${toolName} is enabled by default`);
  }

  const secretInput = {
    path: "src/secret.ts",
    content: "PRIVATE_TOOL_INPUT_FIXTURE",
  };
  await api.emit(
    "tool_call",
    { toolName: "write", toolCallId: "tool-write", input: secretInput },
    context,
  );
  await api.emit(
    "tool_result",
    {
      toolName: "write",
      toolCallId: "tool-write",
      input: secretInput,
      content: [{ type: "text", text: "PRIVATE_TOOL_OUTPUT_FIXTURE" }],
      isError: false,
    },
    context,
  );
  const stopResult = await api.emit("session_stop", { turn_id: 1 }, context);
  assert.ok(
    stopResult &&
      typeof stopResult === "object" &&
      "continue" in stopResult &&
      stopResult.continue === true,
  );

  const failedCheckInput = { command: "omp plugin doctor" };
  await api.emit(
    "tool_call",
    {
      toolName: "bash",
      toolCallId: "tool-check-failed",
      input: failedCheckInput,
    },
    context,
  );
  await api.emit(
    "tool_result",
    {
      toolName: "bash",
      toolCallId: "tool-check-failed",
      input: failedCheckInput,
      content: [{ type: "text", text: "failed" }],
      isError: true,
    },
    context,
  );
  const checkInput = { command: "omp plugin doctor" };
  await api.emit(
    "tool_call",
    { toolName: "bash", toolCallId: "tool-check", input: checkInput },
    context,
  );
  await api.emit(
    "tool_result",
    {
      toolName: "bash",
      toolCallId: "tool-check",
      input: checkInput,
      content: [{ type: "text", text: "3 ok, 0 errors" }],
      isError: false,
    },
    context,
  );
  assert.equal(
    await api.emit("session_stop", { turn_id: 2 }, context),
    undefined,
  );
  await api.commands.get("harness-status")!.handler("", context);
  assert.ok(
    api.logs.some((log) =>
      log.message.includes("verification: verified (epoch 1)"),
    ),
  );
  await api.emit("session_shutdown", { type: "session_shutdown" }, context);
  await api.emit("session_shutdown", { type: "session_shutdown" }, context);

  const run = await readOnlyRunDirectory(join(root, "state"));
  const ledgerText = await readFile(join(run.path, "events.jsonl"), "utf8");
  assert.equal(ledgerText.includes("PRIVATE_TOOL_INPUT_FIXTURE"), false);
  assert.equal(ledgerText.includes("PRIVATE_TOOL_OUTPUT_FIXTURE"), false);
  assert.equal(ledgerText.includes("PRIVATE_SYSTEM_FIXTURE"), false);
  const events = ledgerText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEventV1);
  assert.equal(events.at(-1)?.kind, "run_finished");
  assert.equal(
    events.filter((event) => event.kind === "run_finished").length,
    1,
  );
  const manifest = JSON.parse(
    await readFile(join(run.path, "manifest.json"), "utf8"),
  );
  assert.doesNotThrow(() => validateManifest(manifest, events));
  assert.equal(manifest.verificationStatus, "verified");
  assert.equal(manifest.mutationEpoch, 1);
  assert.equal(manifest.toolCounts.write.ok, 1);
  assert.equal(manifest.toolCounts.bash.error, 1);
  assert.equal(manifest.toolCounts.bash.ok, 1);
  assert.equal(manifest.ledgerHash, sha256Bytes(Buffer.from(ledgerText)));
});

test("adaptive state, staged Refiner output, active components, and models reconstruct from branch entries", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "omp-supercharged-reconstruction-"),
  );
  const restoreEnvironment = setHarnessEnvironment(root);
  t.after(async () => {
    restoreEnvironment();
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  await mkdir(join(project, ".omp"), { recursive: true });
  await writeFile(
    join(project, ".omp", "supercharged.json"),
    JSON.stringify({
      version: 1,
      refiner: {
        enabled: true,
        autoActivate: false,
        triggers: [],
        maxRuns: 2,
        maxInputTokens: 1_000,
        maxOutputTokens: 500,
        maxRuntimeMs: 2_000,
      },
      evaluation: {
        condition: "executable_model",
        taskId: "reconstruction-fixture",
      },
    }),
    "utf8",
  );
  const firstApi = new FakeExtensionApi();
  firstApi.refinerResponse = JSON.stringify({
    proposals: [
      {
        componentKind: "skill",
        name: "refiner-finding",
        payload: {
          description: "Remember that the manual refinement ran",
          instructions: "Preserve the bounded refinement result.",
        },
        rationale: "Preserve the bounded refinement result.",
      },
    ],
  });
  registerHarness(firstApi as never);
  const firstContext = makeContext(project);
  await firstApi.emit("session_start", { type: "session_start" }, firstContext);

  const hypothesis = await executeTool(
    firstApi,
    "hypothesis_portfolio",
    {
      operation: "create",
      id: "__proto__",
      mechanism: "The world model is stale",
      confidence: 0.4,
    },
    firstContext,
  );
  assert.equal(hypothesis.isError, undefined);
  await executeTool(
    firstApi,
    "belief_state",
    {
      operation: "upsert_claim",
      id: "constructor",
      area: "current_plan",
      claim: "Inspect state before acting",
      confidence: 0.8,
      scope: "fixture",
    },
    firstContext,
  );
  const componentResult = await executeTool(
    firstApi,
    "harness_component",
    {
      operation: "propose",
      proposal: {
        componentKind: "skill",
        name: "inspect-first",
        payload: {
          description: "Inspect before acting",
          instructions:
            "Read the current state and cite the observation before proposing a mutation.",
        },
        rationale: "The fixture needs an active, reconstructible component.",
      },
    },
    firstContext,
  );
  assert.ok(
    componentResult.details &&
      typeof componentResult.details === "object" &&
      "id" in componentResult.details,
  );
  const revisionId = componentResult.details.id;
  if (typeof revisionId !== "string")
    throw new TypeError("Component tool did not return a revision id");
  await firstApi.commands
    .get("harness-component-accept")!
    .handler(revisionId, firstContext);
  await executeTool(
    firstApi,
    "executable_model",
    {
      operation: "register",
      id: "__proto__",
      label: "Two-state fixture",
      initialState: "start",
      states: { start: { value: 0 }, done: { value: 1 } },
      transitions: [{ from: "start", action: "advance", to: "done" }],
      goalStates: ["done"],
    },
    firstContext,
  );
  await executeTool(
    firstApi,
    "executable_model",
    {
      operation: "verify_replay",
      modelId: "__proto__",
      fromObservation: { value: 0 },
      action: "advance",
      actualObservation: { value: 1 },
    },
    firstContext,
  );
  await executeTool(
    firstApi,
    "executable_model",
    { operation: "simplify", modelId: "__proto__" },
    firstContext,
  );
  await firstApi.commands
    .get("harness-refine")!
    .handler("manual fixture", firstContext);
  assert.equal(firstApi.refinerOptions.length, 1);
  const refinerOptions = firstApi.refinerOptions[0];
  assert.equal(refinerOptions.disableExtensionDiscovery, true);
  assert.deepEqual(refinerOptions.toolNames, []);
  assert.equal(refinerOptions.enableMCP, false);
  assert.equal(refinerOptions.enableLsp, false);
  const firstInjection = await firstApi.emit(
    "before_agent_start",
    { type: "before_agent_start" },
    firstContext,
  );
  assert.ok(
    firstInjection &&
      typeof firstInjection === "object" &&
      "message" in firstInjection,
  );
  const branch = structuredClone(firstApi.entries);
  assert.ok(
    branch.some(
      (entry) => entry.customType === "omp-supercharged-hypothesis-v1",
    ),
  );
  assert.ok(
    branch.some((entry) => entry.customType === "omp-supercharged-belief-v1"),
  );
  assert.ok(
    branch.some(
      (entry) => entry.customType === "omp-supercharged-component-v1",
    ),
  );
  assert.ok(
    branch.some((entry) => entry.customType === "omp-supercharged-model-v1"),
  );
  await firstApi.emit(
    "session_shutdown",
    { type: "session_shutdown" },
    firstContext,
  );

  const firstRun = await readOnlyRunDirectory(join(root, "state"));
  const existingRuns = new Set([firstRun.name]);
  const secondApi = new FakeExtensionApi();
  registerHarness(secondApi as never);
  const secondContext = makeContext(project, branch);
  await secondApi.emit(
    "session_start",
    { type: "session_start" },
    secondContext,
  );
  const restoredHypotheses = await executeTool(
    secondApi,
    "hypothesis_portfolio",
    { operation: "list" },
    secondContext,
  );
  assert.ok(Array.isArray(restoredHypotheses.details));
  assert.equal(restoredHypotheses.details.length, 1);
  assert.equal(restoredHypotheses.details[0].id, "__proto__");
  const restoredBeliefs = await executeTool(
    secondApi,
    "belief_state",
    { operation: "list" },
    secondContext,
  );
  assert.ok(Array.isArray(restoredBeliefs.details));
  assert.equal(restoredBeliefs.details.length, 1);
  assert.equal(restoredBeliefs.details[0].id, "constructor");
  const restoredModels = await executeTool(
    secondApi,
    "executable_model",
    { operation: "list" },
    secondContext,
  );
  assert.deepEqual(restoredModels.details, ["__proto__"]);
  const secondInjection = await secondApi.emit(
    "before_agent_start",
    { type: "before_agent_start" },
    secondContext,
  );
  assert.ok(
    secondInjection &&
      typeof secondInjection === "object" &&
      "message" in secondInjection,
  );
  const message = secondInjection.message;
  assert.ok(
    message &&
      typeof message === "object" &&
      "content" in message &&
      typeof message.content === "string",
  );
  assert.match(message.content, /Inspect state before acting/u);
  assert.match(message.content, /skill:inspect-first/u);
  assert.match(message.content, /Read the current state/u);
  await secondApi.emit(
    "session_shutdown",
    { type: "session_shutdown" },
    secondContext,
  );

  const secondRun = await readOnlyRunDirectory(
    join(root, "state"),
    existingRuns,
  );
  const secondEvents = (
    await readFile(join(secondRun.path, "events.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEventV1);
  assert.ok(
    secondEvents.some(
      (event) =>
        event.kind === "hypothesis_changed" &&
        event.data.operation === "reconstructed",
    ),
  );
  assert.ok(
    secondEvents.some(
      (event) =>
        event.kind === "belief_changed" &&
        event.data.operation === "reconstructed",
    ),
  );
  assert.ok(
    secondEvents.some(
      (event) =>
        event.kind === "component_changed" && event.data.reconstructed === true,
    ),
  );
  assert.ok(
    secondEvents.some(
      (event) =>
        event.kind === "executable_model_changed" &&
        event.data.operation === "register" &&
        event.parentEventId !== undefined,
    ),
  );
  const restoredModelEvents = secondEvents.filter(
    (
      event,
    ): event is Extract<RunEventV1, { kind: "executable_model_changed" }> =>
      event.kind === "executable_model_changed",
  );
  assert.deepEqual(
    restoredModelEvents.map((event) => event.data.operation),
    ["register", "replay", "simplify"],
  );
  assert.ok(
    restoredModelEvents.every(
      (event) =>
        event.data.model &&
        typeof event.data.model === "object" &&
        !Array.isArray(event.data.model),
    ),
  );
  const reconstructedState = reduceEvents(secondEvents);
  const componentRefs = Object.values(reconstructedState.components);
  assert.ok(componentRefs.length > 0);
  assert.ok(
    componentRefs.every(
      (reference) =>
        reference.kind === "component_revision_ref" &&
        !("payload" in reference) &&
        !("rationale" in reference),
    ),
  );
  assert.ok(
    Object.values(reconstructedState.activeComponents).every(
      (revisionId) => reconstructedState.components[revisionId] !== undefined,
    ),
  );
  assert.equal(reconstructedState.replayRecords.length, 1);
  assert.equal(reconstructedState.hypotheses.__proto__.id, "__proto__");
  assert.equal(
    reconstructedState.beliefs.claims["constructor"].id,
    "constructor",
  );
  assert.equal(reconstructedState.executableModels.__proto__.id, "__proto__");
  const secondManifest = JSON.parse(
    await readFile(join(secondRun.path, "manifest.json"), "utf8"),
  );
  assert.equal(secondManifest.metrics.refinementProposals, 0);
  assert.equal(secondManifest.metrics.acceptedRevisions, 0);
});

test("concurrent tool results serialize mutations before verification and final export", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omp-supercharged-queue-"));
  const restoreEnvironment = setHarnessEnvironment(root);
  t.after(async () => {
    restoreEnvironment();
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const api = new FakeExtensionApi();
  registerHarness(api as never);
  const context = makeContext(project);
  await api.emit("session_start", { type: "session_start" }, context);

  const calls = [
    {
      toolName: "write",
      toolCallId: "mutation-one",
      input: { path: "src/one.ts", content: "one" },
    },
    {
      toolName: "write",
      toolCallId: "mutation-two",
      input: { path: "src/two.ts", content: "two" },
    },
    {
      toolName: "bash",
      toolCallId: "verification-three",
      input: { command: "omp plugin doctor" },
    },
    {
      toolName: "constructor",
      toolCallId: "prototype-tool-four",
      input: { value: "prototype fixture" },
    },
  ];
  for (const call of calls) await api.emit("tool_call", call, context);

  const resultPromises = calls.map((call) =>
    api.emit(
      "tool_result",
      {
        ...call,
        content: [{ type: "text", text: `${call.toolCallId} complete` }],
        isError: false,
      },
      context,
    ),
  );
  const stopPromise = api.emit("session_stop", { turn_id: 1 }, context);
  await Promise.all(resultPromises);
  assert.equal(await stopPromise, undefined);
  await api.emit("session_shutdown", { type: "session_shutdown" }, context);

  const run = await readOnlyRunDirectory(join(root, "state"));
  const ledgerText = await readFile(join(run.path, "events.jsonl"), "utf8");
  const events = ledgerText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEventV1);
  const completed = events.filter(
    (event): event is Extract<RunEventV1, { kind: "tool_completed" }> =>
      event.kind === "tool_completed",
  );
  assert.deepEqual(
    completed.map((event) => event.toolCallId),
    [
      "mutation-one",
      "mutation-two",
      "verification-three",
      "prototype-tool-four",
    ],
  );
  assert.deepEqual(
    completed.map((event) => event.data.mutationEpoch),
    [1, 2, undefined, undefined],
  );
  assert.equal(
    completed[1].data.transition?.observationBefore.ref,
    completed[0].data.transition?.observationAfter.ref,
  );
  assert.equal(
    completed[2].data.transition?.observationBefore.ref,
    completed[1].data.transition?.observationAfter.ref,
  );
  assert.equal(completed[2].data.evidence?.mutationEpoch, 2);
  const reconstructed = reduceEvents(events);
  assert.equal(reconstructed.verification.mutationEpoch, 2);
  assert.equal(reconstructed.verification.status, "verified");
  assert.equal(reconstructed.metrics.actions, 4);
  assert.equal(events.at(-1)?.kind, "run_finished");

  assert.equal(
    completed[3].data.transition?.observationBefore.ref,
    completed[2].data.transition?.observationAfter.ref,
  );
  const manifest = JSON.parse(
    await readFile(join(run.path, "manifest.json"), "utf8"),
  );
  assert.doesNotThrow(() => validateManifest(manifest, events));
  assert.equal(manifest.mutationEpoch, 2);
  assert.equal(reconstructed.metrics.actions, 4);
  assert.equal(manifest.toolCounts.write.ok, 2);
  assert.equal(manifest.toolCounts.bash.ok, 1);
  assert.equal(manifest.toolCounts.constructor.ok, 1);
});

test("manual refinement requires enabled policy and artifact evidence must be recorded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omp-supercharged-disabled-"));
  const restoreEnvironment = setHarnessEnvironment(root);
  t.after(async () => {
    restoreEnvironment();
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  await mkdir(join(project, ".omp"), { recursive: true });
  await writeFile(
    join(project, ".omp", "supercharged.json"),
    JSON.stringify({
      version: 1,
      refiner: { enabled: false },
      evaluation: { condition: "refiner" },
    }),
    "utf8",
  );
  const api = new FakeExtensionApi();
  registerHarness(api as never);
  const context = makeContext(project);
  await api.emit("session_start", { type: "session_start" }, context);

  await assert.rejects(async () => {
    await api.commands.get("harness-refine")!.handler("must not run", context);
  }, /refiner\.enabled=false/u);
  assert.equal(api.refinerOptions.length, 0);
  await assert.rejects(
    executeTool(
      api,
      "harness_component",
      {
        operation: "propose",
        proposal: {
          componentKind: "memory",
          name: "unrecorded-artifact",
          payload: {
            claim: "An arbitrary artifact URI is not evidence",
            confidence: 0.5,
            scope: "fixture",
            evidenceRefs: ["artifact://unrecorded"],
          },
          rationale: "Exercise fail-closed artifact validation.",
        },
      },
      context,
    ),
    /unknown evidence artifact:\/\/unrecorded/u,
  );
  await api.emit("session_shutdown", { type: "session_shutdown" }, context);
});

test("shutdown aborts and awaits an in-flight Refiner before final persistence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omp-supercharged-refiner-stop-"));
  const restoreEnvironment = setHarnessEnvironment(root);
  t.after(async () => {
    restoreEnvironment();
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  await mkdir(join(project, ".omp"), { recursive: true });
  await writeFile(
    join(project, ".omp", "supercharged.json"),
    JSON.stringify({
      version: 1,
      refiner: { enabled: true, maxRuns: 1 },
      evaluation: { condition: "refiner" },
    }),
    "utf8",
  );
  const api = new FakeExtensionApi();
  let enterPrompt!: () => void;
  const promptEntered = new Promise<void>((resolve) => {
    enterPrompt = resolve;
  });
  let rejectPrompt!: (reason: Error) => void;
  api.refinerPrompt = () =>
    new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject;
      enterPrompt();
    });
  api.refinerAbort = () => {
    rejectPrompt(new Error("fixture refiner aborted"));
  };
  registerHarness(api as never);
  const context = makeContext(project);
  await api.emit("session_start", { type: "session_start" }, context);

  const refinement = Promise.resolve(
    api.commands.get("harness-refine")!.handler("blocking fixture", context),
  );
  await promptEntered;
  const refinementRejected = assert.rejects(
    refinement,
    /cancelled during session shutdown/u,
  );
  await api.emit("session_shutdown", { type: "session_shutdown" }, context);
  await refinementRejected;
  assert.equal(api.refinerDisposeCount, 1);

  const run = await readOnlyRunDirectory(join(root, "state"));
  const ledgerPath = join(run.path, "events.jsonl");
  const ledgerText = await readFile(ledgerPath, "utf8");
  const events = ledgerText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEventV1);
  assert.deepEqual(
    events
      .filter((event) =>
        ["refiner_started", "refiner_finished", "run_finished"].includes(
          event.kind,
        ),
      )
      .map((event) => event.kind),
    ["refiner_started", "refiner_finished", "run_finished"],
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await readFile(ledgerPath, "utf8"), ledgerText);
});

test("component activation serializes stale-parent and current-set canaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omp-supercharged-component-cas-"));
  const restoreEnvironment = setHarnessEnvironment(root);
  t.after(async () => {
    restoreEnvironment();
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  await mkdir(join(project, ".omp"), { recursive: true });
  await writeFile(
    join(project, ".omp", "supercharged.json"),
    JSON.stringify({
      version: 1,
      refiner: { enabled: true },
      evaluation: { condition: "refiner" },
    }),
    "utf8",
  );
  const api = new FakeExtensionApi();
  registerHarness(api as never);
  const context = makeContext(project);
  await api.emit("session_start", { type: "session_start" }, context);
  await assert.rejects(
    executeTool(
      api,
      "harness_component",
      {
        operation: "propose",
        proposal: {
          componentKind: "__proto__",
          name: "prototype-kind",
          payload: { instructions: "must be rejected" },
          rationale: "Reject inherited component kinds.",
        },
      },
      context,
    ),
    /Unknown component kind/u,
  );
  await assert.rejects(
    executeTool(
      api,
      "harness_component",
      {
        operation: "propose",
        proposal: {
          componentKind: "agent",
          name: "prototype-tool",
          payload: {
            description: "invalid agent",
            instructions: "must be rejected",
            tools: ["constructor"],
          },
          rationale: "Reject inherited tool allowlist names.",
        },
      },
      context,
    ),
    /not in the read-only allowlist/u,
  );
  await assert.rejects(
    executeTool(
      api,
      "harness_component",
      {
        operation: "propose",
        proposal: {
          componentKind: "skill",
          name: "prototype-field",
          payload: {
            description: "invalid field",
            instructions: "must be rejected",
            toString: "unexpected",
          },
          rationale: "Reject inherited exact-key names.",
        },
      },
      context,
    ),
    /unknown field toString/u,
  );

  const proposeSkill = async (
    name: string,
    description: string,
    instructions: string,
  ): Promise<string> => {
    const result = await executeTool(
      api,
      "harness_component",
      {
        operation: "propose",
        proposal: {
          componentKind: "skill",
          name,
          payload: { description, instructions },
          rationale: "Exercise activation compare-and-set behavior.",
        },
      },
      context,
    );
    assert.ok(
      result.details &&
        typeof result.details === "object" &&
        "id" in result.details &&
        typeof result.details.id === "string",
    );
    return result.details.id;
  };

  const staleA = await proposeSkill("same-key", "first", "first wins");
  const staleB = await proposeSkill("same-key", "second", "second is stale");
  const sameKeyResults = await Promise.allSettled([
    api.commands.get("harness-component-accept")!.handler(staleA, context),
    api.commands.get("harness-component-accept")!.handler(staleB, context),
  ]);
  assert.equal(sameKeyResults[0].status, "fulfilled");
  assert.equal(sameKeyResults[1].status, "rejected");
  if (sameKeyResults[1].status === "rejected")
    assert.match(String(sameKeyResults[1].reason), /is stale/u);

  const largeInstructions = "x".repeat(11_900);
  const largeDescription = "d".repeat(400);
  const largeA = await proposeSkill(
    "large-a",
    largeDescription,
    largeInstructions,
  );
  const largeB = await proposeSkill(
    "large-b",
    largeDescription,
    largeInstructions,
  );
  const currentSetResults = await Promise.allSettled([
    api.commands.get("harness-component-accept")!.handler(largeA, context),
    api.commands.get("harness-component-accept")!.handler(largeB, context),
  ]);
  assert.equal(currentSetResults[0].status, "fulfilled");
  assert.equal(currentSetResults[1].status, "rejected");
  if (currentSetResults[1].status === "rejected")
    assert.match(
      String(currentSetResults[1].reason),
      /projection would exceed/u,
    );

  const injection = await api.emit(
    "before_agent_start",
    { type: "before_agent_start" },
    context,
  );
  assert.ok(
    injection &&
      typeof injection === "object" &&
      "message" in injection &&
      injection.message &&
      typeof injection.message === "object" &&
      "content" in injection.message &&
      typeof injection.message.content === "string",
  );
  assert.match(injection.message.content, /first wins/u);
  assert.doesNotMatch(injection.message.content, /second is stale/u);
  await api.emit("session_shutdown", { type: "session_shutdown" }, context);
});

test("Refiner parser rejects inherited component kind names", () => {
  for (const componentKind of ["constructor", "__proto__", "toString"]) {
    assert.throws(
      () =>
        parseRefinerResponse(
          JSON.stringify({
            proposals: [
              {
                componentKind,
                name: "prototype-kind",
                payload: {},
                rationale: "must be rejected",
              },
            ],
          }),
          1_000,
        ),
      /componentKind is invalid/u,
    );
  }
});
