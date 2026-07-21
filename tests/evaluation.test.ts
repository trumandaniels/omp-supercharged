import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evaluationSpecHash,
  parseEvaluationSuite,
  parseOmpOutputMetrics,
  planEvaluationRuns,
  runEvaluationSuite,
  summarizeEvaluationRuns,
} from "../src/evaluation.ts";
import { canonicalJson, hashJson, sha256Bytes } from "../src/canonical.ts";
import { deriveManifest } from "../src/manifest.ts";
import { DEFAULT_PROJECT_POLICY } from "../src/policy.ts";
import type {
  EvaluationPolicyV1,
  EvaluationRunV1,
  EvaluationSuiteV1,
  ProjectPolicyV1,
  RunEventV1,
} from "../src/types.ts";

function suiteFixture(
  workspace = "/tmp/evaluation-fixture",
): EvaluationSuiteV1 {
  return {
    version: 1,
    kind: "evaluation_suite",
    id: "fixture-ablation",
    models: [
      {
        id: "provider/strong",
        tier: "strong",
        thinkingLevel: "high",
      },
      {
        id: "provider/weak",
        tier: "weak",
        thinkingLevel: "low",
      },
    ],
    tasks: [
      {
        id: "task-a",
        workspace,
        prompt: "Produce the expected result.",
        verifier: {
          command: "node",
          args: ["--test", "test.mjs"],
          timeoutMs: 10_000,
          immutablePaths: ["test.mjs"],
        },
      },
    ],
  };
}

function executionIdentity(suite: EvaluationSuiteV1) {
  return {
    specHash: evaluationSpecHash(suite),
    executionHash:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",

    harnessHash:
      "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    workspaceHash:
      "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    hardeningConfigHash:
      "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    ompVersionHash:
      "sha256:5555555555555555555555555555555555555555555555555555555555555555",
  };
}

async function writeFakeOmp(
  path: string,
  body = "",
  emitSuccessfulResponse = true,
): Promise<void> {
  const successfulResponse = emitSuccessfulResponse
    ? 'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", responseId: "fake-response", usage: { input: 1, output: 1, cost: { total: 0 } } } }));'
    : "";
  await writeFile(
    path,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake-omp 1.0");
  process.exit(0);
}
${body}
${successfulResponse}
`,
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(path, 0o700);
}

function manifestPayloads(): Record<
  string,
  { events: string; manifest: string }
> {
  const payloads: Record<string, { events: string; manifest: string }> = {};
  const conditions: EvaluationPolicyV1["condition"][] = [
    "ledger",
    "state",
    "refiner",
    "executable_model",
  ];
  for (const condition of conditions) {
    const refinerEnabled =
      condition === "refiner" || condition === "executable_model";
    const policy: ProjectPolicyV1 = structuredClone(DEFAULT_PROJECT_POLICY);
    policy.evaluation = { condition, taskId: "task-a" };
    policy.refiner.enabled = refinerEnabled;
    policy.refiner.autoActivate = refinerEnabled;
    policy.refiner.model = "@smol";
    policy.refiner.thinkingLevel = "low";
    policy.refiner.triggers = refinerEnabled
      ? [
          "verification_failure",
          "repeated_tool_failure",
          "budget_stagnation",
          "successful_milestone",
          "belief_contradiction",
        ]
      : [];
    policy.refiner.maxRuns = 2;
    const event = {
      version: 1,
      eventId: `event-${condition}`,
      runId: `run-${condition}`,
      sequence: 1,
      occurredAt: "2026-07-20T12:00:00.000Z",
      kind: "run_started",
      status: "started",
      data: {
        extensionVersion: "0.1.0",
        cwdHash: hashJson({ cwd: "/workspace" }),
        policyHash: hashJson(policy),
        systemPromptHash: hashJson(["system"]),
        evaluationCondition: condition,
        taskId: "task-a",
      },
    } as RunEventV1;
    const events = `${canonicalJson(event)}\n`;
    payloads[condition] = {
      events,
      manifest: canonicalJson(
        deriveManifest([event], sha256Bytes(Buffer.from(events)), policy, {
          extensionVersion: "0.1.0",
        }),
      ),
    };
  }
  return payloads;
}

function completedRun(
  suite: EvaluationSuiteV1,
  plan: ReturnType<typeof planEvaluationRuns>[number],
): EvaluationRunV1 {
  const success = plan.condition !== "stock" || plan.model.tier === "strong";
  return {
    version: 1,
    kind: "evaluation_run",
    id: plan.id,
    suiteId: suite.id,
    specHash: executionIdentity(suite).specHash,
    executionHash: executionIdentity(suite).executionHash,
    harnessHash: executionIdentity(suite).harnessHash,
    workspaceHash: executionIdentity(suite).workspaceHash,
    hardeningConfigHash: executionIdentity(suite).hardeningConfigHash,
    ompVersionHash: executionIdentity(suite).ompVersionHash,
    taskId: plan.task.id,
    replicate: plan.replicate,
    condition: plan.condition,
    model: plan.model.id,
    modelTier: plan.model.tier,
    modelThinkingLevel: plan.model.thinkingLevel,
    promptHash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    startedAt: "2026-07-20T12:00:00.000Z",
    success,
    ...(success
      ? {}
      : {
          failureClass: "task" as const,
          errorHash:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
    actions: plan.condition === "stock" ? 5 : 4,
    modelRequests: plan.model.tier === "strong" ? 2 : 3,
    elapsedMs: plan.condition === "refiner" ? 2_000 : 1_000,
    ...(plan.condition === "stock"
      ? {}
      : {
          verificationDefectsCaught: plan.condition === "ledger" ? 1 : 0,
          falseGateInterventions: 0,
          reconstructionSucceeded: true,
          storageBytes: 1_024,
          waivers: 0,
          regressionsAfterRefinement: 0,
        }),
  };
}

test("evaluation suites require matched strong and weak five-condition slices", () => {
  const suite = parseEvaluationSuite(suiteFixture());
  const plans = planEvaluationRuns(suite);
  assert.equal(plans.length, 10);
  assert.deepEqual(
    suite.models.map((model) => model.thinkingLevel),
    ["high", "low"],
  );
  assert.equal(new Set(plans.map((plan) => plan.id)).size, plans.length);
  assert.notDeepEqual(
    plans.slice(0, 5).map((plan) => plan.condition),
    plans.slice(5, 10).map((plan) => plan.condition),
  );

  const runs = plans.map((plan) => completedRun(suite, plan));
  const report = summarizeEvaluationRuns(
    suite,
    runs,
    executionIdentity(suite),
    () => Date.parse("2026-07-20T13:00:00.000Z"),
  );
  assert.equal(report.runCount, 10);
  assert.equal(report.completePairs, 2);
  assert.equal(report.weakModelPairs, 1);
  assert.equal(report.summaries.stock?.successRate, 0.5);
  assert.equal(report.summaries.stock?.taskFailures, 1);
  assert.equal(report.summaries.stock?.providerFailures, 0);
  assert.equal(report.summaries.stock?.harnessFailures, 0);
  assert.equal(report.summaries.ledger?.meanVerificationDefectsCaught, 1);

  const noWeak = structuredClone(suiteFixture());
  noWeak.models = [
    { id: "provider/strong", tier: "strong", thinkingLevel: "high" },
  ];
  assert.throws(
    () => parseEvaluationSuite(noWeak),
    /at least two models|weak-model/u,
  );

  const invalidThinking = structuredClone(suiteFixture()) as unknown as {
    models: { thinkingLevel: string }[];
  };
  invalidThinking.models[1].thinkingLevel = "auto";
  assert.throws(() => parseEvaluationSuite(invalidThinking), /thinkingLevel/u);

  for (const [command, args] of [
    ["npm", ["--test", "test.mjs"]],
    ["npm.cmd", ["--test", "test.mjs"]],
    ["npm.exe", ["--test", "test.mjs"]],
    ["bun", ["--test", "test.mjs"]],
    ["corepack", ["--test", "test.mjs"]],
    ["sh", ["-c", "npm install"]],
    ["node", ["-e", "require('child_process').execSync('npm install')"]],
  ] as const) {
    const unsafeVerifier = structuredClone(suiteFixture());
    unsafeVerifier.tasks[0].verifier.command = command;
    unsafeVerifier.tasks[0].verifier.args = [...args];
    assert.throws(
      () => parseEvaluationSuite(unsafeVerifier),
      /fail-closed verifier|Socket Firewall/u,
    );
  }

  for (const immutablePaths of [
    undefined,
    [],
    ["../test.mjs"],
    ["/tmp/test.mjs"],
    ["test.mjs", "test.mjs"],
    ["dir\\test.mjs"],
  ]) {
    const unsafePaths = structuredClone(suiteFixture()) as unknown as {
      tasks: { verifier: { immutablePaths?: string[] } }[];
    };
    unsafePaths.tasks[0].verifier.immutablePaths = immutablePaths;
    assert.throws(() => parseEvaluationSuite(unsafePaths), /immutablePaths/u);
  }
});

test("OMP JSON metrics count unique provider responses without storing prose", () => {
  const response = {
    type: "message_end",
    message: {
      role: "assistant",
      responseId: "response-1",
      usage: {
        input: 100,
        output: 20,
        cost: { total: 0.25 },
      },
    },
  };
  const stdout = [
    JSON.stringify(response),
    JSON.stringify(response),
    JSON.stringify({ type: "tool_execution_end" }),
    "non-json startup notice",
  ].join("\n");
  assert.deepEqual(parseOmpOutputMetrics(stdout), {
    actions: 1,
    modelRequests: 1,
    modelErrors: 0,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.25,
    malformedLines: 0,
  });
  const providerError = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "rate limited",
    },
  });
  assert.deepEqual(parseOmpOutputMetrics(providerError), {
    actions: 0,
    modelRequests: 0,
    modelErrors: 1,
    malformedLines: 0,
  });
});

test("evaluation runner copies workspaces, executes every pair, and emits a resumable report", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "omp-supercharged-evaluation-test-"),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  const extension = join(root, "extension");
  await mkdir(extension);
  for (const artifact of ["package.json", "src", "skills", "config"]) {
    await cp(join(process.cwd(), artifact), join(extension, artifact), {
      recursive: true,
    });
  }
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "seed.txt"), "seed\n", "utf8");
  await writeFile(
    join(workspace, "test.mjs"),
    `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("result", async () => {
  assert.equal(await readFile("result.txt", "utf8"), "ready\\n");
});
`,
    "utf8",
  );
  const fakeOmp = join(root, "fake-omp.mjs");
  const argumentsLog = join(root, "arguments.jsonl");
  await writeFile(
    fakeOmp,
    `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("fake-omp 1.0");
  process.exit(0);
}
appendFileSync(${JSON.stringify(argumentsLog)}, JSON.stringify(args) + "\\n", "utf8");
const cwdIndex = args.indexOf("--cwd");
const cwd = args[cwdIndex + 1];
writeFileSync(join(cwd, "result.txt"), "ready\\n", "utf8");
console.log(JSON.stringify({ type: "tool_execution_end" }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", responseId: "fake-response", usage: { input: 10, output: 2, cost: { total: 0.01 } } } }));
`,
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(fakeOmp, 0o700);
  const suite = suiteFixture(workspace);
  const outputRoot = join(root, "output");
  let wallClock = Date.parse("2026-07-20T12:00:00.000Z");
  let monotonicClock = 0;
  const first = await runEvaluationSuite(suite, {
    ompExecutable: fakeOmp,
    outputRoot,
    extensionPath: extension,
    clock: () => (wallClock += 3_600_000),
    monotonicClock: () => (monotonicClock += 25),
  });
  assert.equal(first.runs.length, 10);
  assert.equal(
    first.runs.every((run) => run.elapsedMs === 25),
    true,
  );
  const observedArguments = (await readFile(argumentsLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(observedArguments.length, 10);
  for (const args of observedArguments) {
    const model = args[args.indexOf("--model") + 1];
    const thinkingLevel = args[args.indexOf("--thinking") + 1];
    assert.equal(
      thinkingLevel,
      suite.models.find((candidate) => candidate.id === model)?.thinkingLevel,
    );
  }
  assert.equal(
    first.runs
      .filter((run) => run.condition === "stock")
      .every((run) => run.success && run.failureClass === undefined),
    true,
  );
  assert.equal(
    first.runs
      .filter((run) => run.condition !== "stock")
      .every(
        (run) =>
          !run.success &&
          run.failureClass === "harness" &&
          run.errorHash !== undefined,
      ),
    true,
  );
  assert.equal(first.report.completePairs, 2);
  assert.equal(first.report.weakModelPairs, 1);
  assert.equal(first.report.summaries.ledger?.harnessFailures, 2);
  assert.equal(
    first.runs.find((run) => run.condition === "stock")
      ?.reconstructionSucceeded,
    undefined,
  );
  assert.equal(
    first.runs.find((run) => run.condition === "ledger")
      ?.reconstructionSucceeded,
    false,
  );
  const missingManifestRun = first.runs.find(
    (run) => run.condition === "ledger",
  );
  assert.equal(missingManifestRun?.verificationDefectsCaught, undefined);
  assert.equal(missingManifestRun?.failureClass, "harness");
  assert.equal(missingManifestRun?.errorHash?.startsWith("sha256:"), true);
  assert.equal(missingManifestRun?.regressionsAfterRefinement, undefined);
  assert.equal(missingManifestRun?.waivers, undefined);
  assert.equal(missingManifestRun?.falseGateInterventions, undefined);

  await writeFile(
    fakeOmp,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake-omp 1.0");
  process.exit(0);
}
process.exit(97);
`,
    "utf8",
  );

  const resumed = await runEvaluationSuite(suite, {
    ompExecutable: fakeOmp,
    outputRoot,
    extensionPath: extension,
  });
  assert.deepEqual(
    resumed.runs.map((run) => run.id),
    first.runs.map((run) => run.id),
  );

  const corruptRun = { ...first.runs[0], success: "not-a-boolean" };
  await writeFile(
    join(outputRoot, "runs", `${first.runs[0].id}.json`),
    JSON.stringify(corruptRun),
    "utf8",
  );
  await assert.rejects(
    () =>
      runEvaluationSuite(suite, {
        ompExecutable: fakeOmp,
        outputRoot,
        extensionPath: extension,
      }),
    /success must be boolean/u,
  );
});

test("provider errors cannot pass pre-solved evaluation fixtures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-provider-error-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "test.mjs"),
    'import test from "node:test"; test("already passes", () => {});\n',
    "utf8",
  );
  const fakeOmp = join(root, "fake-omp.mjs");
  await writeFakeOmp(
    fakeOmp,
    `console.log(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    stopReason: "error",
    errorMessage: "provider quota exhausted"
  }
}));`,
    false,
  );
  const result = await runEvaluationSuite(suiteFixture(workspace), {
    ompExecutable: fakeOmp,
    outputRoot: join(root, "output"),
    extensionPath: process.cwd(),
  });
  assert.equal(result.runs.length, 10);
  assert.equal(
    result.runs.every(
      (run) =>
        !run.success &&
        run.failureClass === "provider" &&
        run.modelRequests === 0 &&
        run.verifierExitCode === 0 &&
        run.errorHash !== undefined,
    ),
    true,
  );
  assert.equal(
    Object.values(result.report.summaries).every(
      (summary) => summary?.providerFailures === 2,
    ),
    true,
  );
});

test("evaluation runner rejects workspace symlinks before execution", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "omp-supercharged-evaluation-symlink-"),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside\n", "utf8");
  await symlink(outside, join(workspace, "linked.txt"));
  const suite = suiteFixture(workspace);
  await assert.rejects(
    () =>
      runEvaluationSuite(suite, {
        ompExecutable: "/path/that/must/not/run",
        outputRoot: join(root, "output"),
      }),
    /may not contain symbolic links/u,
  );
});

test("evaluation rejects verifier tampering without executing the modified contract", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-verifier-tamper-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "test.mjs"),
    'throw new Error("the pristine verifier was executed");\n',
    "utf8",
  );
  const fakeOmp = join(root, "fake-omp.mjs");
  await writeFakeOmp(
    fakeOmp,
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const cwd = args[args.indexOf("--cwd") + 1];
writeFileSync(join(cwd, "test.mjs"), "");
`,
  );
  const result = await runEvaluationSuite(suiteFixture(workspace), {
    ompExecutable: fakeOmp,
    outputRoot: join(root, "output"),
    extensionPath: process.cwd(),
  });
  assert.equal(
    result.runs.every((run) => !run.success),
    true,
  );
  assert.equal(
    result.runs.every((run) => run.verifierExitCode === undefined),
    true,
  );
});

test("timed-out verifiers terminate descendant process trees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-tree-kill-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const marker = join(root, "delayed-marker.txt");
  const startedMarker = join(root, "grandchild-started.txt");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "test.mjs"),
    'import test from "node:test"; test("pass", () => {});\n',
    "utf8",
  );
  const verifierDirectory = join(root, "verifier-bin");
  await mkdir(verifierDirectory);
  const verifierNode = join(verifierDirectory, "node");
  await writeFile(
    verifierNode,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(
      `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 15000)`,
    )}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(startedMarker)}, String(child.pid));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`,
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(verifierNode, 0o700);
  const fakeOmp = join(root, "fake-omp.mjs");
  await writeFakeOmp(fakeOmp);
  const suite = suiteFixture(workspace);
  suite.tasks[0].verifier.command = verifierNode;
  suite.tasks[0].verifier.timeoutMs = 5000;
  const result = await runEvaluationSuite(suite, {
    ompExecutable: fakeOmp,
    outputRoot: join(root, "output"),
    extensionPath: process.cwd(),
  });
  assert.equal(
    result.runs.every((run) => !run.success),
    true,
    JSON.stringify(
      result.runs.map((run) => ({
        condition: run.condition,
        success: run.success,
        verifierExitCode: run.verifierExitCode,
        errorHash: run.errorHash,
      })),
    ),
  );
  assert.match(await readFile(startedMarker, "utf8"), /^[1-9]\d*$/u);
  await assert.rejects(() => readFile(marker), { code: "ENOENT" });
});

test("interrupted cells clear stale controlled runtime state before rerun", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-runtime-cleanup-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "test.mjs"),
    `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("runtime was clean", async () => {
  assert.equal(await readFile("runtime-clean.txt", "utf8"), "clean");
});
`,
    "utf8",
  );
  const suite = suiteFixture(workspace);
  const outputRoot = join(root, "output");
  for (const plan of planEvaluationRuns(suite)) {
    const staleRun = join(
      outputRoot,
      "runtime",
      plan.id,
      "xdg-state",
      "omp-supercharged",
      "runs",
      "stale",
    );
    await mkdir(staleRun, { recursive: true });
    await writeFile(join(staleRun, "manifest.json"), "{}\n", "utf8");
  }
  const fakeOmp = join(root, "fake-omp.mjs");
  await writeFakeOmp(
    fakeOmp,
    `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const cwd = args[args.indexOf("--cwd") + 1];
const runs = join(process.env.XDG_STATE_HOME, "omp-supercharged", "runs");
writeFileSync(join(cwd, "runtime-clean.txt"), existsSync(runs) ? "dirty" : "clean");
const policyPath = join(cwd, ".omp", "supercharged.json");
if (existsSync(policyPath)) {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const payload = ${JSON.stringify(manifestPayloads())}[policy.evaluation.condition];
  const run = join(runs, "only");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "events.jsonl"), payload.events);
  writeFileSync(join(run, "manifest.json"), payload.manifest);
}
`,
  );
  const result = await runEvaluationSuite(suite, {
    ompExecutable: fakeOmp,
    outputRoot,
    extensionPath: process.cwd(),
  });
  assert.equal(
    result.runs.every((run) => run.success),
    true,
  );
  assert.equal(
    result.runs
      .filter((run) => run.condition !== "stock")
      .every((run) => run.reconstructionSucceeded === true),
    true,
  );
});

test("manifest reconstruction requires canonical event-derived equality", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-manifest-equality-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "test.mjs"),
    'import test from "node:test"; test("pass", () => {});\n',
    "utf8",
  );
  const manifests = manifestPayloads();
  const fieldTampered = JSON.parse(manifests.ledger.manifest) as Record<
    string,
    unknown
  >;
  fieldTampered.retryCount = 1;
  manifests.ledger.manifest = canonicalJson(fieldTampered);
  const hashTampered = JSON.parse(manifests.state.manifest) as Record<
    string,
    unknown
  >;
  hashTampered.ledgerHash =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  manifests.state.manifest = canonicalJson(hashTampered);
  const fakeOmp = join(root, "fake-omp.mjs");
  await writeFakeOmp(
    fakeOmp,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const cwd = args[args.indexOf("--cwd") + 1];
const policy = JSON.parse(readFileSync(join(cwd, ".omp", "supercharged.json"), "utf8"));
const payload = ${JSON.stringify(manifests)}[policy.evaluation.condition];
const run = join(process.env.XDG_STATE_HOME, "omp-supercharged", "runs", "only");
mkdirSync(run, { recursive: true });
writeFileSync(join(run, "events.jsonl"), payload.events);
writeFileSync(join(run, "manifest.json"), payload.manifest);
`,
  );
  const result = await runEvaluationSuite(suiteFixture(workspace), {
    ompExecutable: fakeOmp,
    outputRoot: join(root, "output"),
    extensionPath: process.cwd(),
  });
  for (const condition of ["ledger", "state"] as const) {
    assert.equal(
      result.runs
        .filter((run) => run.condition === condition)
        .every(
          (run) =>
            run.reconstructionSucceeded === false &&
            !run.success &&
            run.failureClass === "harness",
        ),
      true,
    );
  }
  for (const condition of ["refiner", "executable_model"] as const) {
    assert.equal(
      result.runs
        .filter((run) => run.condition === condition)
        .every(
          (run) =>
            run.reconstructionSucceeded === true &&
            run.success &&
            run.failureClass === undefined,
        ),
      true,
    );
  }
});

test("skill bytes participate identically in harness snapshots and execution identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-skill-identity-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "test.mjs"),
    'import test from "node:test"; test("pass", () => {});\n',
    "utf8",
  );
  const extensions = [join(root, "extension-a"), join(root, "extension-b")];
  for (const extension of extensions) {
    await mkdir(extension);
    for (const artifact of ["package.json", "src", "skills", "config"]) {
      await cp(join(process.cwd(), artifact), join(extension, artifact), {
        recursive: true,
      });
    }
  }
  await writeFile(
    join(extensions[1], "skills", "evidence-harness", "SKILL.md"),
    "changed skill bytes\n",
    "utf8",
  );
  const fakeOmp = join(root, "fake-omp.mjs");
  await writeFakeOmp(fakeOmp);
  const first = await runEvaluationSuite(suiteFixture(workspace), {
    ompExecutable: fakeOmp,
    outputRoot: join(root, "output-a"),
    extensionPath: extensions[0],
  });
  const second = await runEvaluationSuite(suiteFixture(workspace), {
    ompExecutable: fakeOmp,
    outputRoot: join(root, "output-b"),
    extensionPath: extensions[1],
  });
  assert.notEqual(first.report.harnessHash, second.report.harnessHash);
  assert.notEqual(first.report.executionHash, second.report.executionHash);
  assert.equal(
    first.runs.every((run) => run.harnessHash === first.report.harnessHash),
    true,
  );
  assert.equal(
    second.runs.every((run) => run.harnessHash === second.report.harnessHash),
    true,
  );
});
