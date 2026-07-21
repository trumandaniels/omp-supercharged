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
import { registerHarness } from "../src/runtime.ts";
import type { RunEventV1 } from "../src/types.ts";

interface RegisteredTool {
  name: string;
  execute: (
    ...args: unknown[]
  ) => Promise<{
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
          prompt: async (_prompt: string, _options: unknown) => undefined,
          dispose: async () => undefined,
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
        componentKind: "memory",
        name: "refiner-finding",
        payload: {
          claim: "The manual refinement ran",
          confidence: 0.6,
          scope: "fixture",
          evidenceRefs: ["artifact://refiner-fixture"],
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
      id: "hypothesis-a",
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
      id: "belief-a",
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
      id: "model-a",
      label: "Two-state fixture",
      initialState: "start",
      states: { start: { value: 0 }, done: { value: 1 } },
      transitions: [{ from: "start", action: "advance", to: "done" }],
      goalStates: ["done"],
    },
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
  const restoredBeliefs = await executeTool(
    secondApi,
    "belief_state",
    { operation: "list" },
    secondContext,
  );
  assert.ok(Array.isArray(restoredBeliefs.details));
  assert.equal(restoredBeliefs.details.length, 1);
  const restoredModels = await executeTool(
    secondApi,
    "executable_model",
    { operation: "list" },
    secondContext,
  );
  assert.deepEqual(restoredModels.details, ["model-a"]);
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
        event.data.operation === "reconstructed",
    ),
  );
  const secondManifest = JSON.parse(
    await readFile(join(secondRun.path, "manifest.json"), "utf8"),
  );
  assert.equal(secondManifest.metrics.refinementProposals, 0);
  assert.equal(secondManifest.metrics.acceptedRevisions, 0);
});
