import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
import type { EvaluationRunV1, EvaluationSuiteV1 } from "../src/types.ts";

function suiteFixture(workspace = "/tmp/evaluation-fixture"): EvaluationSuiteV1 {
  return {
    version: 1,
    kind: "evaluation_suite",
    id: "fixture-ablation",
    models: [
      { id: "provider/strong", tier: "strong" },
      { id: "provider/weak", tier: "weak" },
    ],
    tasks: [
      {
        id: "task-a",
        workspace,
        prompt: "Produce the expected result.",
        verifier: {
          command: "node",
          args: ["-e", "process.exit(0)"],
          timeoutMs: 10_000,
        },
      },
    ],
  };
}

function completedRun(
  suite: EvaluationSuiteV1,
  plan: ReturnType<typeof planEvaluationRuns>[number],
): EvaluationRunV1 {
  return {
    version: 1,
    kind: "evaluation_run",
    id: plan.id,
    suiteId: suite.id,
    specHash: evaluationSpecHash(suite),
    taskId: plan.task.id,
    replicate: plan.replicate,
    condition: plan.condition,
    model: plan.model.id,
    modelTier: plan.model.tier,
    promptHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    startedAt: "2026-07-20T12:00:00.000Z",
    success: plan.condition !== "stock" || plan.model.tier === "strong",
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
  assert.equal(new Set(plans.map((plan) => plan.id)).size, plans.length);
  assert.notDeepEqual(
    plans.slice(0, 5).map((plan) => plan.condition),
    plans.slice(5, 10).map((plan) => plan.condition),
  );

  const runs = plans.map((plan) => completedRun(suite, plan));
  const report = summarizeEvaluationRuns(
    suite,
    runs,
    () => Date.parse("2026-07-20T13:00:00.000Z"),
  );
  assert.equal(report.runCount, 10);
  assert.equal(report.completePairs, 2);
  assert.equal(report.weakModelPairs, 1);
  assert.equal(report.summaries.stock?.successRate, 0.5);
  assert.equal(report.summaries.ledger?.meanVerificationDefectsCaught, 1);

  const noWeak = structuredClone(suiteFixture());
  noWeak.models = [{ id: "provider/strong", tier: "strong" }];
  assert.throws(() => parseEvaluationSuite(noWeak), /at least two models|weak-model/u);

  const barePackageManager = structuredClone(suiteFixture());
  barePackageManager.tasks[0].verifier.command = "npm";
  assert.throws(
    () => parseEvaluationSuite(barePackageManager),
    /Socket Firewall wrapper/u,
  );
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
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.25,
    malformedLines: 0,
  });
});

test("evaluation runner copies workspaces, executes every pair, and emits a resumable report", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omp-supercharged-evaluation-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "seed.txt"), "seed\n", "utf8");
  const fakeOmp = join(root, "fake-omp.mjs");
  await writeFile(
    fakeOmp,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
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
  suite.tasks[0].verifier = {
    command: "node",
    args: [
      "-e",
      "const fs=require('node:fs');process.exit(fs.readFileSync('result.txt','utf8')==='ready\\n'?0:1)",
    ],
    timeoutMs: 10_000,
  };
  const outputRoot = join(root, "output");
  const first = await runEvaluationSuite(suite, {
    ompExecutable: fakeOmp,
    outputRoot,
    extensionPath: process.cwd(),
  });
  assert.equal(first.runs.length, 10);
  assert.equal(first.runs.every((run) => run.success), true);
  assert.equal(first.report.completePairs, 2);
  assert.equal(first.report.weakModelPairs, 1);
  assert.equal(first.runs.find((run) => run.condition === "stock")?.reconstructionSucceeded, undefined);
  assert.equal(first.runs.find((run) => run.condition === "ledger")?.reconstructionSucceeded, false);

  const resumed = await runEvaluationSuite(suite, {
    ompExecutable: "/path/that/must/not/run",
    outputRoot,
    extensionPath: process.cwd(),
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
        ompExecutable: "/path/that/must/not/run",
        outputRoot,
        extensionPath: process.cwd(),
      }),
    /success must be boolean/u,
  );
});

test("evaluation runner rejects workspace symlinks before execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omp-supercharged-evaluation-symlink-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside\n", "utf8");
  await symlink(outside, join(workspace, "linked.txt"));
  const fakeOmp = join(root, "must-not-run.mjs");
  await writeFile(fakeOmp, "#!/usr/bin/env node\nprocess.exit(0);\n", {
    encoding: "utf8",
    mode: 0o700,
  });
  await chmod(fakeOmp, 0o700);
  const suite = suiteFixture(workspace);
  suite.tasks[0].verifier = {
    command: "node",
    args: ["-e", "process.exit(0)"],
    timeoutMs: 10_000,
  };
  const result = await runEvaluationSuite(suite, {
    ompExecutable: fakeOmp,
    outputRoot: join(root, "output"),
  });
  assert.equal(result.runs.every((run) => !run.success), true);
  assert.equal(result.runs.every((run) => run.errorHash !== undefined), true);
});
