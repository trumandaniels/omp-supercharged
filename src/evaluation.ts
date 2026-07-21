import { spawn, type ChildProcess } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  lstat,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, hashJson, isoNow, sha256Bytes } from "./canonical.ts";
import { recoverLedger } from "./ledger.ts";
import { deriveManifest } from "./manifest.ts";
import { loadProjectPolicy } from "./policy.ts";
import {
  ensurePrivateDirectory,
  resolveHarnessPaths,
  writePrivateAtomic,
} from "./paths.ts";
import type {
  EvaluationExecutionIdentityV1,
  EvaluationFailureClass,
  EvaluationConditionSummaryV1,
  EvaluationPolicyV1,
  EvaluationReportV1,
  EvaluationRunV1,
  EvaluationSuiteV1,
  EvaluationThinkingLevel,
  EvaluationTaskV1,
  JsonObject,
  RunManifestV1,
} from "./types.ts";

export const EVALUATION_CONDITIONS = [
  "stock",
  "ledger",
  "state",
  "refiner",
  "executable_model",
] as const satisfies readonly EvaluationPolicyV1["condition"][];

const CONDITION_ORDER: Record<EvaluationPolicyV1["condition"], number> = {
  stock: 0,
  ledger: 1,
  state: 2,
  refiner: 3,
  executable_model: 4,
};

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function activeOmpAgentDirectory(): string {
  const explicit = process.env.PI_CODING_AGENT_DIR?.trim();
  if (explicit) return resolve(explicit);
  const configuredRoot = process.env.PI_CONFIG_DIR?.trim();
  const configRoot = configuredRoot
    ? isAbsolute(configuredRoot)
      ? configuredRoot
      : join(homedir(), configuredRoot)
    : join(homedir(), ".omp");
  return join(configRoot, "agent");
}

const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const PROCESS_TEARDOWN_LIMIT_MS = 5_000;
const RUNTIME_ARTIFACT_PATHS = ["package.json", "src", "skills"] as const;

interface EvaluationRunPlan {
  id: string;
  task: EvaluationTaskV1;
  model: EvaluationSuiteV1["models"][number];
  condition: EvaluationPolicyV1["condition"];
  replicate: number;
}

interface ProcessResult {
  exitCode?: number;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  captureExceeded: boolean;
}

interface OmpOutputMetrics {
  actions: number;
  modelRequests: number;
  inputTokens?: number;
  modelErrors: number;
  outputTokens?: number;
  costUsd?: number;
  malformedLines: number;
}

interface ManifestEvidence {
  manifest?: RunManifestV1;
  reconstructionSucceeded: boolean;
  storageBytes: number;

  waivers: number;
  continuationDecisions: number;
}

const EVALUATION_FAILURE_CLASSES = new Set<EvaluationFailureClass>([
  "provider",
  "harness",
  "task",
]);

const EVALUATION_THINKING_LEVELS = new Set<EvaluationThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function parseEvaluationThinkingLevel(
  value: unknown,
  context: string,
): EvaluationThinkingLevel {
  if (
    typeof value !== "string" ||
    !EVALUATION_THINKING_LEVELS.has(value as EvaluationThinkingLevel)
  ) {
    throw new TypeError(
      `${context} must be off, minimal, low, medium, high, xhigh, or max`,
    );
  }
  return value as EvaluationThinkingLevel;
}

interface EvaluationExecutionIdentity extends EvaluationExecutionIdentityV1 {
  specHash: string;
}

interface EvaluationSuiteSnapshot {
  root: string;
  suite: EvaluationSuiteV1;
  workspaceHash: string;
}

interface EvaluationHarnessSnapshot {
  root: string;
  harnessHash: string;
  hardeningConfigHash: string;
}

export interface EvaluationRunnerOptions {
  extensionPath?: string;
  hardeningConfigPath?: string;
  ompExecutable?: string;
  outputRoot?: string;
  keepWorkspaces?: boolean;
  clock?: () => number;
}

export interface EvaluationSuiteResult {
  report: EvaluationReportV1;
  runs: EvaluationRunV1[];
  outputRoot: string;
  reportPath: string;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function errorCode(error: unknown): string | undefined {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${context} contains unknown field ${key}`);
    }
  }
}

function nonEmptyString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new TypeError(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value.trim();
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite number`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${field} must be boolean`);
  return value;
}

function contentHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 content hash`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new TypeError(`${field} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return value;
}

function parseCondition(
  value: unknown,
  field: string,
): EvaluationPolicyV1["condition"] {
  if (
    value !== "stock" &&
    value !== "ledger" &&
    value !== "state" &&
    value !== "refiner" &&
    value !== "executable_model"
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function parseStringArray(
  value: unknown,
  field: string,
  maxItems: number,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(
      `${field} must be an array with at most ${maxItems} entries`,
    );
  }
  return value.map((item, index) =>
    nonEmptyString(item, `${field}[${index}]`, 4_000),
  );
}

function safeRelativeFilePath(value: unknown, field: string): string {
  const path = nonEmptyString(value, field, 4_000);
  if (
    path !== value ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path === "." ||
    path === ".." ||
    path.startsWith("../") ||
    path.endsWith("/") ||
    posix.normalize(path) !== path ||
    path
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new TypeError(
      `${field} must be a normalized safe relative file path`,
    );
  }
  return path;
}

function parseImmutablePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new TypeError(
      `${field} must be a non-empty array with at most 100 entries`,
    );
  }
  const paths = value.map((item, index) =>
    safeRelativeFilePath(item, `${field}[${index}]`),
  );
  if (new Set(paths).size !== paths.length) {
    throw new TypeError(`${field} must not contain duplicate paths`);
  }
  return paths;
}

function parseVerifier(
  value: unknown,
  context: string,
): EvaluationTaskV1["verifier"] {
  const verifier = asRecord(value, context);
  assertExactKeys(
    verifier,
    ["command", "args", "timeoutMs", "immutablePaths"],
    context,
  );
  const command = nonEmptyString(verifier.command, `${context}.command`, 1_000);
  const commandName = basename(command).toLowerCase();
  const args = parseStringArray(verifier.args, `${context}.args`, 100);
  if (
    (commandName !== "node" && commandName !== "node.exe") ||
    args.length !== 2 ||
    args[0] !== "--test" ||
    !/\.(?:c|m)?js$|\.ts$/u.test(
      safeRelativeFilePath(args[1], `${context}.args[1]`),
    )
  ) {
    throw new TypeError(
      `${context} must use the fail-closed verifier form node --test <safe-relative-test-file>; package managers and interpreter indirection must use an age-gated Socket Firewall workflow outside evaluation`,
    );
  }
  return {
    command,
    args,
    timeoutMs: boundedInteger(
      verifier.timeoutMs,
      `${context}.timeoutMs`,
      100,
      3_600_000,
    ),
    immutablePaths: parseImmutablePaths(
      verifier.immutablePaths,
      `${context}.immutablePaths`,
    ),
  };
}

export function parseEvaluationSuite(
  value: unknown,
  baseDirectory = process.cwd(),
): EvaluationSuiteV1 {
  const suite = asRecord(value, "Evaluation suite");
  assertExactKeys(
    suite,
    [
      "version",
      "kind",
      "id",
      "models",
      "tasks",
      "conditions",
      "repetitions",
      "refinerModel",
    ],
    "Evaluation suite",
  );
  if (suite.version !== 1 || suite.kind !== "evaluation_suite") {
    throw new TypeError("Unsupported evaluation suite contract");
  }
  const id = nonEmptyString(suite.id, "Evaluation suite id", 100);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    throw new TypeError(
      "Evaluation suite id must contain lowercase letters, digits, and hyphens",
    );
  }
  if (!Array.isArray(suite.models) || suite.models.length < 2) {
    throw new TypeError("Evaluation suite requires at least two models");
  }
  const modelIds = new Set<string>();
  const models = suite.models.map((rawModel, index) => {
    const model = asRecord(rawModel, `Evaluation suite models[${index}]`);
    assertExactKeys(
      model,
      ["id", "tier", "thinkingLevel"],
      `Evaluation suite models[${index}]`,
    );
    const modelId = nonEmptyString(
      model.id,
      `Evaluation suite models[${index}].id`,
      200,
    );
    if (modelIds.has(modelId)) {
      throw new TypeError(
        `Evaluation suite contains duplicate model ${modelId}`,
      );
    }
    modelIds.add(modelId);
    let tier: "strong" | "weak";
    if (model.tier === "strong") tier = "strong";
    else if (model.tier === "weak") tier = "weak";
    else {
      throw new TypeError(
        `Evaluation suite models[${index}].tier must be strong or weak`,
      );
    }
    const thinkingLevel = parseEvaluationThinkingLevel(
      model.thinkingLevel,
      `Evaluation suite models[${index}].thinkingLevel`,
    );
    return { id: modelId, tier, thinkingLevel };
  });
  if (!models.some((model) => model.tier === "strong")) {
    throw new TypeError("Evaluation suite requires a strong-model slice");
  }
  if (!models.some((model) => model.tier === "weak")) {
    throw new TypeError("Evaluation suite requires a weak-model slice");
  }
  if (!Array.isArray(suite.tasks) || suite.tasks.length === 0) {
    throw new TypeError("Evaluation suite requires at least one task");
  }
  const taskIds = new Set<string>();
  const tasks = suite.tasks.map((rawTask, index) => {
    const task = asRecord(rawTask, `Evaluation suite tasks[${index}]`);
    assertExactKeys(
      task,
      ["id", "workspace", "prompt", "verifier", "maxRunSeconds"],
      `Evaluation suite tasks[${index}]`,
    );
    const taskId = nonEmptyString(
      task.id,
      `Evaluation suite tasks[${index}].id`,
      200,
    );
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(taskId)) {
      throw new TypeError(`Evaluation task id ${taskId} is not path-safe`);
    }
    if (taskIds.has(taskId)) {
      throw new TypeError(`Evaluation suite contains duplicate task ${taskId}`);
    }
    taskIds.add(taskId);
    const workspaceInput = nonEmptyString(
      task.workspace,
      `Evaluation suite tasks[${index}].workspace`,
      4_000,
    );
    const workspace = isAbsolute(workspaceInput)
      ? workspaceInput
      : resolve(baseDirectory, workspaceInput);
    const parsed: EvaluationTaskV1 = {
      id: taskId,
      workspace,
      prompt: nonEmptyString(
        task.prompt,
        `Evaluation suite tasks[${index}].prompt`,
        32_000,
      ),
      verifier: parseVerifier(
        task.verifier,
        `Evaluation suite tasks[${index}].verifier`,
      ),
    };
    if (task.maxRunSeconds !== undefined) {
      parsed.maxRunSeconds = boundedInteger(
        task.maxRunSeconds,
        `Evaluation suite tasks[${index}].maxRunSeconds`,
        10,
        3_600,
      );
    }
    return parsed;
  });
  let conditions: EvaluationPolicyV1["condition"][] | undefined;
  if (suite.conditions !== undefined) {
    if (!Array.isArray(suite.conditions)) {
      throw new TypeError("Evaluation suite conditions must be an array");
    }
    const seen = new Set<EvaluationPolicyV1["condition"]>();
    conditions = suite.conditions.map((condition, index) => {
      const parsed = parseCondition(
        condition,
        `Evaluation suite conditions[${index}]`,
      );
      if (seen.has(parsed)) {
        throw new TypeError(
          `Evaluation suite contains duplicate condition ${parsed}`,
        );
      }
      seen.add(parsed);
      return parsed;
    });
    for (const required of EVALUATION_CONDITIONS) {
      if (!seen.has(required)) {
        throw new TypeError(
          `Comparative evaluation requires the ${required} condition`,
        );
      }
    }
  }
  const parsedSuite: EvaluationSuiteV1 = {
    version: 1,
    kind: "evaluation_suite",
    id,
    models,
    tasks,
  };
  if (conditions !== undefined) parsedSuite.conditions = conditions;
  if (suite.repetitions !== undefined) {
    parsedSuite.repetitions = boundedInteger(
      suite.repetitions,
      "Evaluation suite repetitions",
      1,
      10,
    );
  }
  if (suite.refinerModel !== undefined) {
    parsedSuite.refinerModel = nonEmptyString(
      suite.refinerModel,
      "Evaluation suite refinerModel",
      200,
    );
  }
  return parsedSuite;
}

function suiteConditions(
  suite: EvaluationSuiteV1,
): EvaluationPolicyV1["condition"][] {
  return suite.conditions ? [...suite.conditions] : [...EVALUATION_CONDITIONS];
}

export function evaluationSpecHash(suite: EvaluationSuiteV1): string {
  return hashJson({
    ...suite,
    conditions: suiteConditions(suite),
    repetitions: suite.repetitions ?? 1,
  });
}

function rotateConditions(
  conditions: readonly EvaluationPolicyV1["condition"][],
  offset: number,
): EvaluationPolicyV1["condition"][] {
  const normalized = offset % conditions.length;
  return [...conditions.slice(normalized), ...conditions.slice(0, normalized)];
}

export function planEvaluationRuns(
  suite: EvaluationSuiteV1,
): EvaluationRunPlan[] {
  const conditions = suiteConditions(suite);
  const repetitions = suite.repetitions ?? 1;
  const plans: EvaluationRunPlan[] = [];
  for (let replicate = 1; replicate <= repetitions; replicate++) {
    for (let taskIndex = 0; taskIndex < suite.tasks.length; taskIndex++) {
      const task = suite.tasks[taskIndex];
      for (let modelIndex = 0; modelIndex < suite.models.length; modelIndex++) {
        const model = suite.models[modelIndex];
        const orderedConditions = rotateConditions(
          conditions,
          replicate - 1 + taskIndex + modelIndex,
        );
        for (const condition of orderedConditions) {
          const identity = {
            suiteId: suite.id,
            taskId: task.id,
            model: model.id,
            replicate,
            condition,
          };
          plans.push({
            id: `evaluation-run-${hashJson(identity).slice(7, 23)}`,
            task,
            model,
            condition,
            replicate,
          });
        }
      }
    }
  }
  return plans;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
}

function optionalMean(
  values: readonly (number | undefined)[],
): number | undefined {
  const observed = values.filter(
    (value): value is number => value !== undefined,
  );
  if (observed.length === 0) return undefined;
  return observed.reduce((sum, value) => sum + value, 0) / observed.length;
}

function summarizeCondition(
  runs: readonly EvaluationRunV1[],
): EvaluationConditionSummaryV1 {
  const successes = runs.filter((run) => run.success).length;
  const summary: EvaluationConditionSummaryV1 = {
    runs: runs.length,
    successes,
    successRate: runs.length === 0 ? 0 : successes / runs.length,
    providerFailures: runs.filter((run) => run.failureClass === "provider")
      .length,
    harnessFailures: runs.filter((run) => run.failureClass === "harness")
      .length,
    taskFailures: runs.filter((run) => run.failureClass === "task").length,
    medianActions: median(runs.map((run) => run.actions)),
    medianModelRequests: median(runs.map((run) => run.modelRequests)),
    medianElapsedMs: median(runs.map((run) => run.elapsedMs)),
  };
  const verificationDefects = optionalMean(
    runs.map((run) => run.verificationDefectsCaught),
  );
  if (verificationDefects !== undefined) {
    summary.meanVerificationDefectsCaught = verificationDefects;
  }
  const falseGates = runs
    .map((run) => run.falseGateInterventions)
    .filter((value): value is number => value !== undefined)
    .reduce((sum, value) => sum + value, 0);
  if (runs.some((run) => run.falseGateInterventions !== undefined)) {
    summary.falseGateInterventions = falseGates;
  }
  const storage = optionalMean(runs.map((run) => run.storageBytes));
  if (storage !== undefined) summary.meanStorageBytes = storage;
  const cost = optionalMean(runs.map((run) => run.primaryCostUsd));
  if (cost !== undefined) summary.meanPrimaryCostUsd = cost;
  return summary;
}

export function summarizeEvaluationRuns(
  suite: EvaluationSuiteV1,
  runs: readonly EvaluationRunV1[],
  identity: EvaluationExecutionIdentity,
  clock: () => number = Date.now,
): EvaluationReportV1 {
  const specHash = identity.specHash;
  const conditions = suiteConditions(suite);
  const expectedPlans = planEvaluationRuns(suite);
  const expectedIds = new Set(expectedPlans.map((plan) => plan.id));
  const observedIds = new Set<string>();
  for (const run of runs) {
    if (
      run.suiteId !== suite.id ||
      run.specHash !== specHash ||
      run.executionHash !== identity.executionHash ||
      run.harnessHash !== identity.harnessHash ||
      run.workspaceHash !== identity.workspaceHash ||
      run.hardeningConfigHash !== identity.hardeningConfigHash ||
      run.ompVersionHash !== identity.ompVersionHash
    ) {
      throw new TypeError(
        `Evaluation run ${run.id} belongs to a different execution`,
      );
    }
    if (!expectedIds.has(run.id)) {
      throw new TypeError(`Unexpected evaluation run ${run.id}`);
    }
    if (observedIds.has(run.id)) {
      throw new TypeError(`Duplicate evaluation run ${run.id}`);
    }
    observedIds.add(run.id);
  }
  const pairConditions = new Map<
    string,
    Set<EvaluationPolicyV1["condition"]>
  >();
  const weakPairs = new Set<string>();
  for (const run of runs) {
    const pairKey = `${run.taskId}\u0000${run.model}\u0000${run.replicate}`;
    const observed = pairConditions.get(pairKey) ?? new Set();
    observed.add(run.condition);
    pairConditions.set(pairKey, observed);
    if (run.modelTier === "weak") weakPairs.add(pairKey);
  }
  let completePairs = 0;
  let weakModelPairs = 0;
  for (const [pairKey, observed] of pairConditions) {
    if (conditions.every((condition) => observed.has(condition))) {
      completePairs++;
      if (weakPairs.has(pairKey)) weakModelPairs++;
    }
  }
  const summaries: EvaluationReportV1["summaries"] = {};
  for (const condition of conditions) {
    const matching = runs.filter((run) => run.condition === condition);
    if (matching.length > 0)
      summaries[condition] = summarizeCondition(matching);
  }
  return {
    version: 1,
    kind: "evaluation_report",
    suiteId: suite.id,
    specHash,
    executionHash: identity.executionHash,
    harnessHash: identity.harnessHash,
    workspaceHash: identity.workspaceHash,
    hardeningConfigHash: identity.hardeningConfigHash,
    ompVersionHash: identity.ompVersionHash,
    generatedAt: isoNow(clock),
    conditions,
    runCount: runs.length,
    completePairs,
    weakModelPairs,
    summaries,
    runIds: [...observedIds].sort(),
  };
}

function evaluationPolicy(
  suite: EvaluationSuiteV1,
  taskId: string,
  condition: EvaluationPolicyV1["condition"],
): JsonObject {
  const refinerEnabled = CONDITION_ORDER[condition] >= CONDITION_ORDER.refiner;
  return {
    version: 1,
    evaluation: { condition, taskId },
    refiner: {
      enabled: refinerEnabled,
      autoActivate: refinerEnabled,
      model: suite.refinerModel ?? "@smol",
      thinkingLevel: "low",
      triggers: refinerEnabled
        ? [
            "verification_failure",
            "repeated_tool_failure",
            "budget_stagnation",
            "successful_milestone",
            "belief_contradiction",
          ]
        : [],
      maxRuns: 2,
    },
  };
}

function appendCapture(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; exceeded: boolean },
): void {
  if (state.exceeded) return;
  state.bytes += chunk.byteLength;
  if (state.bytes > MAX_CAPTURE_BYTES) {
    state.exceeded = true;
    return;
  }
  chunks.push(chunk);
}

async function signalProcessTree(
  child: ChildProcess,
  force: boolean,
): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const { promise, resolve: resolveKill } = Promise.withResolvers<void>();
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
      {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    killer.once("error", () => {
      child.kill(force ? "SIGKILL" : "SIGTERM");
      resolveKill();
    });
    killer.once("close", () => resolveKill());
    killer.unref();
    await promise;
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (errorCode(error) !== "ESRCH") {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    }
  }
}

async function runProcess(
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<ProcessResult> {
  const {
    promise,
    resolve: resolveProcess,
    reject: rejectProcess,
  } = Promise.withResolvers<ProcessResult>();
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdoutState = { bytes: 0, exceeded: false };
  const stderrState = { bytes: 0, exceeded: false };
  let timedOut = false;
  let settled = false;
  let terminating = false;
  let observedExitCode: number | null = null;
  let observedSignal: NodeJS.Signals | null = null;
  let teardown: NodeJS.Timeout | undefined;
  let terminationComplete: Promise<void> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);

  const finish = (
    exitCode: number | null = observedExitCode,
    signal: NodeJS.Signals | null = observedSignal,
  ): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(teardown);
    const result: ProcessResult = {
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      timedOut,
      captureExceeded: stdoutState.exceeded || stderrState.exceeded,
    };
    if (exitCode !== null) result.exitCode = exitCode;
    if (signal !== null) result.signal = signal;
    resolveProcess(result);
  };

  const terminate = (): void => {
    if (terminating || settled) return;
    terminating = true;
    terminationComplete = signalProcessTree(child, true);
    teardown = setTimeout(() => {
      if (settled) return;
      child.stdout.destroy();
      child.stderr.destroy();
      finish();
    }, PROCESS_TEARDOWN_LIMIT_MS);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    appendCapture(stdoutChunks, chunk, stdoutState);
    if (stdoutState.exceeded) terminate();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    appendCapture(stderrChunks, chunk, stderrState);
    if (stderrState.exceeded) terminate();
  });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(teardown);
    rejectProcess(error);
  });
  child.once("exit", (exitCode, signal) => {
    observedExitCode = exitCode;
    observedSignal = signal;
  });
  child.once("close", (exitCode, signal) => {
    if (terminationComplete) {
      void terminationComplete.then(() => finish(exitCode, signal));
    } else {
      finish(exitCode, signal);
    }
  });
  return promise;
}

function finiteMetric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function parseOmpOutputMetrics(stdout: string): OmpOutputMetrics {
  const responseIds = new Set<string>();
  let actions = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let observedInput = false;
  let observedOutput = false;
  let observedCost = false;
  let malformedLines = 0;
  let modelErrors = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !("type" in parsed)
    ) {
      continue;
    }
    if (parsed.type === "tool_execution_end") actions++;
    if (parsed.type !== "message_end" || !("message" in parsed)) continue;
    const message = parsed.message;
    if (
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      !("role" in message) ||
      message.role !== "assistant"
    ) {
      continue;
    }
    if ("stopReason" in message && message.stopReason === "error") {
      modelErrors++;
    }
    if (!("responseId" in message) || typeof message.responseId !== "string") {
      continue;
    }
    if (responseIds.has(message.responseId)) continue;
    responseIds.add(message.responseId);
    if (!("usage" in message)) continue;
    const usage = message.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) continue;
    const input = "input" in usage ? finiteMetric(usage.input) : undefined;
    const output = "output" in usage ? finiteMetric(usage.output) : undefined;
    if (input !== undefined) {
      inputTokens += input;
      observedInput = true;
    }
    if (output !== undefined) {
      outputTokens += output;
      observedOutput = true;
    }
    const cost = "cost" in usage ? usage.cost : undefined;
    if (
      cost &&
      typeof cost === "object" &&
      !Array.isArray(cost) &&
      "total" in cost
    ) {
      const total = finiteMetric(cost.total);
      if (total !== undefined) {
        costUsd += total;
        observedCost = true;
      }
    }
  }
  const metrics: OmpOutputMetrics = {
    actions,
    modelRequests: responseIds.size,
    modelErrors,
    malformedLines,
  };
  if (observedInput) metrics.inputTokens = inputTokens;
  if (observedOutput) metrics.outputTokens = outputTokens;
  if (observedCost) metrics.costUsd = costUsd;
  return metrics;
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) total += await directoryBytes(child);
      else if (entry.isFile()) total += (await stat(child)).size;
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
  return total;
}

async function readManifestEvidence(
  stateHome: string,
  dataHome: string,
  workspace: string,
  extensionPath: string,
): Promise<ManifestEvidence> {
  const runsRoot = join(stateHome, "omp-supercharged", "runs");
  let runDirectories: string[] = [];
  try {
    runDirectories = (await readdir(runsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(runsRoot, entry.name));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const evidence: ManifestEvidence = {
    reconstructionSucceeded: false,
    storageBytes:
      (await directoryBytes(stateHome)) + (await directoryBytes(dataHome)),
    waivers: 0,
    continuationDecisions: 0,
  };
  if (runDirectories.length !== 1) return evidence;
  const runDirectory = runDirectories[0];
  try {
    const eventsPath = join(runDirectory, "events.jsonl");
    const eventsBytes = await readFile(eventsPath);
    const recovery = await recoverLedger(eventsPath);
    if (recovery.truncatedTail !== undefined || recovery.events.length === 0) {
      return evidence;
    }
    const loadedPolicy = await loadProjectPolicy(workspace);
    if (loadedPolicy.error) return evidence;
    const packageValue = asRecord(
      JSON.parse(await readFile(join(extensionPath, "package.json"), "utf8")),
      "Evaluation harness package",
    );
    const expected = deriveManifest(
      recovery.events,
      sha256Bytes(eventsBytes),
      loadedPolicy.policy,
      {
        extensionVersion: nonEmptyString(
          packageValue.version,
          "Evaluation harness package version",
          100,
        ),
      },
    );
    const manifestValue: unknown = JSON.parse(
      await readFile(join(runDirectory, "manifest.json"), "utf8"),
    );
    if (canonicalJson(manifestValue) !== canonicalJson(expected)) {
      return evidence;
    }
    evidence.manifest = expected;
    evidence.reconstructionSucceeded = true;
    evidence.waivers = recovery.events.filter(
      (event) => event.kind === "verification_waived",
    ).length;
    evidence.continuationDecisions = recovery.events.filter(
      (event) =>
        event.kind === "stop_decided" &&
        (event.data.decision === "continue" || event.data.decision === "block"),
    ).length;
  } catch {
    return evidence;
  }
  return evidence;
}

const EXCLUDED_WORKSPACE_NAMES = new Set([".git", "node_modules", ".venv"]);

interface FingerprintEntry {
  path: string;
  type: "directory" | "file";
  mode?: number;
  hash?: string;
}

async function collectFingerprintEntries(
  absolutePath: string,
  logicalPath: string,
  excludedNames: ReadonlySet<string>,
  context: string,
  entries: FingerprintEntry[],
): Promise<void> {
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink()) {
    throw new TypeError(
      `${context} may not contain symbolic links: ${absolutePath}`,
    );
  }
  if (info.isFile()) {
    entries.push({
      path: logicalPath,
      type: "file",
      mode: info.mode & 0o777,
      hash: sha256Bytes(await readFile(absolutePath)),
    });
    return;
  }
  if (!info.isDirectory()) {
    throw new TypeError(
      `${context} may contain only files and directories: ${absolutePath}`,
    );
  }
  entries.push({ path: logicalPath, type: "directory" });
  const children = await readdir(absolutePath, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (excludedNames.has(child.name)) continue;
    await collectFingerprintEntries(
      join(absolutePath, child.name),
      logicalPath === "." ? child.name : `${logicalPath}/${child.name}`,
      excludedNames,
      context,
      entries,
    );
  }
}

async function fingerprintTree(
  root: string,
  excludedNames: ReadonlySet<string>,
  context: string,
): Promise<string> {
  const entries: FingerprintEntry[] = [];
  await collectFingerprintEntries(root, ".", excludedNames, context, entries);
  return hashJson({ entries });
}

async function fingerprintHarness(extensionPath: string): Promise<string> {
  const entries: FingerprintEntry[] = [];
  const excluded = new Set<string>();
  for (const relativePath of RUNTIME_ARTIFACT_PATHS) {
    await collectFingerprintEntries(
      join(extensionPath, relativePath),
      relativePath,
      excluded,
      "Evaluation harness source",
      entries,
    );
  }
  return hashJson({ entries });
}

async function fingerprintImmutableFiles(
  root: string,
  paths: readonly string[],
): Promise<string> {
  const entries: { path: string; hash: string }[] = [];
  for (const relativePath of paths) {
    const absolutePath = join(root, relativePath);
    let info;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new Error(`Immutable verifier path is missing: ${relativePath}`);
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Immutable verifier path is a symlink: ${relativePath}`);
    }
    if (!info.isFile()) {
      throw new Error(`Immutable verifier path is not a file: ${relativePath}`);
    }
    entries.push({
      path: relativePath,
      hash: sha256Bytes(await readFile(absolutePath)),
    });
  }
  return hashJson({ entries });
}

async function copyWorkspaceTree(
  sourceRoot: string,
  destination: string,
): Promise<string> {
  const before = await fingerprintTree(
    sourceRoot,
    EXCLUDED_WORKSPACE_NAMES,
    "Evaluation workspace",
  );
  await cp(sourceRoot, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (source) =>
      source === sourceRoot || !EXCLUDED_WORKSPACE_NAMES.has(basename(source)),
  });
  const after = await fingerprintTree(
    destination,
    new Set<string>(),
    "Evaluation workspace snapshot",
  );
  if (before !== after) {
    await rm(destination, { recursive: true, force: true });
    throw new Error(
      `Evaluation workspace changed while being copied: ${sourceRoot}`,
    );
  }
  return before;
}

async function snapshotEvaluationSuite(
  suite: EvaluationSuiteV1,
): Promise<EvaluationSuiteSnapshot> {
  const root = await mkdtemp(join(tmpdir(), "omp-supercharged-suite-"));
  try {
    const tasks: EvaluationTaskV1[] = [];
    const taskHashes: { taskId: string; hash: string }[] = [];
    for (let index = 0; index < suite.tasks.length; index++) {
      const task = suite.tasks[index];
      const destination = join(root, `task-${index + 1}`);
      const hash = await copyWorkspaceTree(
        resolve(task.workspace),
        destination,
      );
      tasks.push({ ...task, workspace: destination });
      taskHashes.push({ taskId: task.id, hash });
    }
    return {
      root,
      suite: { ...suite, tasks },
      workspaceHash: hashJson({ tasks: taskHashes }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function snapshotEvaluationHarness(
  options: EvaluationRunnerOptions,
): Promise<EvaluationHarnessSnapshot> {
  const sourceRoot = resolve(options.extensionPath ?? PACKAGE_ROOT);
  const sourceHardeningPath = resolve(
    options.hardeningConfigPath ?? join(sourceRoot, "config", "hardened.yml"),
  );
  const root = await mkdtemp(join(tmpdir(), "omp-supercharged-harness-"));
  try {
    const harnessHash = await fingerprintHarness(sourceRoot);
    const hardeningConfigHash = sha256Bytes(
      await readFile(sourceHardeningPath),
    );
    for (const relativePath of RUNTIME_ARTIFACT_PATHS) {
      await cp(join(sourceRoot, relativePath), join(root, relativePath), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    const configRoot = join(root, "config");
    await ensurePrivateDirectory(configRoot);
    await cp(sourceHardeningPath, join(configRoot, "hardened.yml"), {
      force: false,
      errorOnExist: true,
    });
    if (
      (await fingerprintHarness(root)) !== harnessHash ||
      sha256Bytes(await readFile(join(configRoot, "hardened.yml"))) !==
        hardeningConfigHash
    ) {
      throw new Error("Evaluation harness changed while being copied");
    }
    return { root, harnessHash, hardeningConfigHash };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function buildExecutionIdentity(
  suite: EvaluationSuiteV1,
  suiteSnapshot: EvaluationSuiteSnapshot,
  harnessSnapshot: EvaluationHarnessSnapshot,
  options: EvaluationRunnerOptions,
): Promise<EvaluationExecutionIdentity> {
  const harnessHash = harnessSnapshot.harnessHash;
  const hardeningConfigHash = harnessSnapshot.hardeningConfigHash;
  const ompExecutable = options.ompExecutable ?? "omp";
  const versionResult = await runProcess(ompExecutable, ["--version"], {
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  const version = versionResult.stdout.trim();
  if (
    versionResult.exitCode !== 0 ||
    versionResult.timedOut ||
    versionResult.captureExceeded ||
    version.length === 0
  ) {
    throw new Error(
      `Unable to fingerprint evaluation executable ${ompExecutable}`,
    );
  }
  const specHash = evaluationSpecHash(suite);
  const identityWithoutExecution = {
    specHash,
    harnessHash,
    workspaceHash: suiteSnapshot.workspaceHash,
    hardeningConfigHash,
    ompVersionHash: hashJson({
      executable: ompExecutable,
      version,
      stderrHash: hashJson({ stderr: versionResult.stderr }),
    }),
  };
  return {
    ...identityWithoutExecution,
    executionHash: hashJson(identityWithoutExecution),
  };
}

async function prepareWorkspace(
  plan: EvaluationRunPlan,
  suite: EvaluationSuiteV1,
): Promise<{ root: string; cwd: string }> {
  const sourceRoot = resolve(plan.task.workspace);
  const root = await mkdtemp(join(tmpdir(), "omp-supercharged-evaluation-"));
  try {
    const cwd = join(root, "workspace");
    await copyWorkspaceTree(sourceRoot, cwd);
    if (plan.condition !== "stock") {
      const policyDirectory = join(cwd, ".omp");
      await ensurePrivateDirectory(policyDirectory);
      await writeFile(
        join(policyDirectory, "supercharged.json"),
        `${canonicalJson(evaluationPolicy(suite, plan.task.id, plan.condition))}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
    return { root, cwd };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function baseRun(
  suite: EvaluationSuiteV1,
  plan: EvaluationRunPlan,
  identity: EvaluationExecutionIdentity,
  startedAt: string,
): Omit<
  EvaluationRunV1,
  "success" | "actions" | "modelRequests" | "elapsedMs"
> {
  return {
    version: 1,
    kind: "evaluation_run",
    id: plan.id,
    suiteId: suite.id,
    specHash: identity.specHash,
    executionHash: identity.executionHash,
    harnessHash: identity.harnessHash,
    workspaceHash: identity.workspaceHash,
    hardeningConfigHash: identity.hardeningConfigHash,
    ompVersionHash: identity.ompVersionHash,
    taskId: plan.task.id,
    replicate: plan.replicate,
    condition: plan.condition,
    model: plan.model.id,
    modelTier: plan.model.tier,
    modelThinkingLevel: plan.model.thinkingLevel,
    promptHash: hashJson({ prompt: plan.task.prompt }),
    startedAt,
  };
}

async function executeEvaluationRun(
  suite: EvaluationSuiteV1,
  plan: EvaluationRunPlan,
  identity: EvaluationExecutionIdentity,
  runRoot: string,
  options: EvaluationRunnerOptions,
): Promise<EvaluationRunV1> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const startedAt = new Date(started).toISOString();
  let workspaceRoot: string | undefined;
  let isolatedConfigRoot: string | undefined;
  try {
    const workspace = await prepareWorkspace(plan, suite);
    workspaceRoot = workspace.root;
    const stateHome = join(runRoot, "xdg-state");
    const dataHome = join(runRoot, "xdg-data");
    await ensurePrivateDirectory(stateHome);
    await ensurePrivateDirectory(dataHome);
    isolatedConfigRoot = join(runRoot, "omp-config");
    await ensurePrivateDirectory(isolatedConfigRoot);
    const extensionPath = resolve(options.extensionPath ?? PACKAGE_ROOT);
    const hardeningConfigPath = resolve(
      options.hardeningConfigPath ??
        join(extensionPath, "config", "hardened.yml"),
    );
    const immutableFingerprint = await fingerprintImmutableFiles(
      workspace.cwd,
      plan.task.verifier.immutablePaths,
    );
    const maxRunSeconds = plan.task.maxRunSeconds ?? 1_200;
    const args = [
      "--model",
      plan.model.id,
      "--thinking",
      plan.model.thinkingLevel,
      "--cwd",
      workspace.cwd,
      "--mode",
      "json",
      "--no-session",
      "--max-time",
      String(maxRunSeconds),
      "--approval-mode",
      "yolo",
      "--config",
      hardeningConfigPath,
    ];
    if (plan.condition === "stock") args.push("--no-extensions");
    else args.push("--extension", extensionPath);
    args.push("-p", plan.task.prompt);
    const ompResult = await runProcess(options.ompExecutable ?? "omp", args, {
      cwd: workspace.cwd,
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PI_CONFIG_DIR: isolatedConfigRoot,
        PI_CODING_AGENT_DIR: activeOmpAgentDirectory(),
      },
      timeoutMs: (maxRunSeconds + 30) * 1_000,
    });
    const immutableFingerprintAfter = await fingerprintImmutableFiles(
      workspace.cwd,
      plan.task.verifier.immutablePaths,
    );
    if (immutableFingerprintAfter !== immutableFingerprint) {
      throw new Error("Immutable verifier contract changed during evaluation");
    }
    const outputMetrics = parseOmpOutputMetrics(ompResult.stdout);
    const verifierResult = await runProcess(
      plan.task.verifier.command,
      plan.task.verifier.args,
      {
        cwd: workspace.cwd,
        timeoutMs: plan.task.verifier.timeoutMs,
      },
    );
    const manifestEvidence =
      plan.condition === "stock"
        ? undefined
        : await readManifestEvidence(
            stateHome,
            dataHome,
            workspace.cwd,
            extensionPath,
          );
    const verifierSucceeded =
      verifierResult.exitCode === 0 &&
      !verifierResult.timedOut &&
      !verifierResult.captureExceeded;
    const processSucceeded =
      ompResult.exitCode === 0 &&
      !ompResult.timedOut &&
      !ompResult.captureExceeded &&
      outputMetrics.malformedLines === 0 &&
      outputMetrics.modelRequests > 0 &&
      outputMetrics.modelErrors === 0;
    const reconstructionSucceeded =
      manifestEvidence === undefined ||
      manifestEvidence.reconstructionSucceeded;
    const runSucceeded =
      processSucceeded && verifierSucceeded && reconstructionSucceeded;
    const manifest = manifestEvidence?.manifest;
    const result: EvaluationRunV1 = {
      ...baseRun(suite, plan, identity, startedAt),
      success: runSucceeded,
      actions: manifest?.metrics.actions ?? outputMetrics.actions,
      modelRequests:
        outputMetrics.modelRequests + (manifest?.metrics.modelRequests ?? 0),
      elapsedMs: Math.max(0, clock() - started),
    };
    if (!runSucceeded) {
      result.failureClass =
        outputMetrics.modelErrors > 0
          ? "provider"
          : !processSucceeded || !reconstructionSucceeded
            ? "harness"
            : "task";
    }
    if (outputMetrics.inputTokens !== undefined) {
      result.primaryInputTokens = outputMetrics.inputTokens;
    }
    if (outputMetrics.outputTokens !== undefined) {
      result.primaryOutputTokens = outputMetrics.outputTokens;
    }
    if (outputMetrics.costUsd !== undefined) {
      result.primaryCostUsd = outputMetrics.costUsd;
    }
    if (ompResult.exitCode !== undefined)
      result.processExitCode = ompResult.exitCode;
    if (verifierResult.exitCode !== undefined) {
      result.verifierExitCode = verifierResult.exitCode;
    }
    if (manifestEvidence !== undefined) {
      result.reconstructionSucceeded = manifestEvidence.reconstructionSucceeded;
      result.storageBytes = manifestEvidence.storageBytes;
      if (manifest !== undefined) {
        result.waivers = manifestEvidence.waivers;
        result.verificationDefectsCaught =
          manifest.metrics.verificationFailures;
        result.regressionsAfterRefinement =
          manifest.metrics.rolledBackRevisions;
        const staleSuccessfulRun =
          runSucceeded && manifest.verificationStatus === "stale";
        result.falseGateInterventions = staleSuccessfulRun
          ? Math.max(1, manifestEvidence.continuationDecisions)
          : 0;
      }
    }
    if (!runSucceeded) {
      result.errorHash = hashJson({
        processExitCode: ompResult.exitCode ?? "unknown",
        processSignal: ompResult.signal ?? "none",
        processTimedOut: ompResult.timedOut,
        processCaptureExceeded: ompResult.captureExceeded,
        processStderrHash: hashJson({ stderr: ompResult.stderr }),
        malformedOutputLines: outputMetrics.malformedLines,
        modelErrors: outputMetrics.modelErrors,
        failureClass: result.failureClass,
        verifierExitCode: verifierResult.exitCode ?? "unknown",
        verifierSignal: verifierResult.signal ?? "none",
        verifierTimedOut: verifierResult.timedOut,
        verifierCaptureExceeded: verifierResult.captureExceeded,
        verifierStderrHash: hashJson({ stderr: verifierResult.stderr }),
        reconstructionSucceeded:
          manifestEvidence?.reconstructionSucceeded ?? "not_applicable",
      });
    }
    return result;
  } catch (error) {
    return {
      ...baseRun(suite, plan, identity, startedAt),
      success: false,
      failureClass: "harness",
      actions: 0,
      modelRequests: 0,
      elapsedMs: Math.max(0, clock() - started),
      errorHash: hashJson({
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      }),
    };
  } finally {
    if (workspaceRoot && !options.keepWorkspaces) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
    if (isolatedConfigRoot) {
      await rm(isolatedConfigRoot, { recursive: true, force: true });
    }
  }
}

function validateStoredRun(
  value: unknown,
  suite: EvaluationSuiteV1,
  plan: EvaluationRunPlan,
  identity: EvaluationExecutionIdentity,
): EvaluationRunV1 {
  const context = `Stored evaluation run ${plan.id}`;
  const run = asRecord(value, context);
  const allowed = [
    "version",
    "kind",
    "id",
    "suiteId",
    "specHash",
    "executionHash",
    "harnessHash",
    "workspaceHash",
    "hardeningConfigHash",
    "ompVersionHash",
    "taskId",
    "replicate",
    "condition",
    "model",
    "modelTier",
    "modelThinkingLevel",
    "promptHash",
    "startedAt",
    "success",
    "failureClass",
    "actions",
    "modelRequests",
    "elapsedMs",
    "verificationDefectsCaught",
    "falseGateInterventions",
    "reconstructionSucceeded",
    "storageBytes",
    "waivers",
    "regressionsAfterRefinement",
    "primaryInputTokens",
    "primaryOutputTokens",
    "primaryCostUsd",
    "processExitCode",
    "verifierExitCode",
    "errorHash",
  ];
  assertExactKeys(run, allowed, context);
  if (
    run.version !== 1 ||
    run.kind !== "evaluation_run" ||
    run.id !== plan.id ||
    run.suiteId !== suite.id ||
    run.specHash !== identity.specHash ||
    run.executionHash !== identity.executionHash ||
    run.harnessHash !== identity.harnessHash ||
    run.workspaceHash !== identity.workspaceHash ||
    run.hardeningConfigHash !== identity.hardeningConfigHash ||
    run.ompVersionHash !== identity.ompVersionHash
  ) {
    throw new TypeError(`${context} is incompatible`);
  }
  const taskId = nonEmptyString(run.taskId, `${context}.taskId`, 200);
  const model = nonEmptyString(run.model, `${context}.model`, 200);
  const condition = parseCondition(run.condition, `${context}.condition`);
  const modelTier = run.modelTier;
  const modelThinkingLevel = parseEvaluationThinkingLevel(
    run.modelThinkingLevel,
    `${context}.modelThinkingLevel`,
  );
  if (modelTier !== "strong" && modelTier !== "weak") {
    throw new TypeError(`${context}.modelTier is invalid`);
  }
  if (
    taskId !== plan.task.id ||
    model !== plan.model.id ||
    condition !== plan.condition ||
    modelTier !== plan.model.tier ||
    modelThinkingLevel !== plan.model.thinkingLevel ||
    run.replicate !== plan.replicate ||
    run.promptHash !== hashJson({ prompt: plan.task.prompt })
  ) {
    throw new TypeError(`${context} does not match its planned cell`);
  }
  const parsed: EvaluationRunV1 = {
    version: 1,
    kind: "evaluation_run",
    id: plan.id,
    suiteId: suite.id,
    specHash: contentHash(run.specHash, `${context}.specHash`),
    executionHash: contentHash(run.executionHash, `${context}.executionHash`),
    harnessHash: contentHash(run.harnessHash, `${context}.harnessHash`),
    workspaceHash: contentHash(run.workspaceHash, `${context}.workspaceHash`),
    hardeningConfigHash: contentHash(
      run.hardeningConfigHash,
      `${context}.hardeningConfigHash`,
    ),
    ompVersionHash: contentHash(
      run.ompVersionHash,
      `${context}.ompVersionHash`,
    ),
    taskId,
    replicate: boundedInteger(
      run.replicate,
      `${context}.replicate`,
      1,
      suite.repetitions ?? 1,
    ),
    condition,
    model,
    modelTier,
    modelThinkingLevel,
    promptHash: contentHash(run.promptHash, `${context}.promptHash`),
    startedAt: timestamp(run.startedAt, `${context}.startedAt`),
    success: booleanValue(run.success, `${context}.success`),
    actions: boundedInteger(
      run.actions,
      `${context}.actions`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    modelRequests: boundedInteger(
      run.modelRequests,
      `${context}.modelRequests`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    elapsedMs: finiteNonNegative(run.elapsedMs, `${context}.elapsedMs`),
  };
  if (run.failureClass !== undefined) {
    if (
      typeof run.failureClass !== "string" ||
      !EVALUATION_FAILURE_CLASSES.has(
        run.failureClass as EvaluationFailureClass,
      )
    ) {
      throw new TypeError(`${context}.failureClass is invalid`);
    }
    parsed.failureClass = run.failureClass as EvaluationFailureClass;
  }
  if (parsed.success === (parsed.failureClass !== undefined)) {
    throw new TypeError(`${context} success and failureClass are inconsistent`);
  }
  if (run.verificationDefectsCaught !== undefined) {
    parsed.verificationDefectsCaught = boundedInteger(
      run.verificationDefectsCaught,
      `${context}.verificationDefectsCaught`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (run.falseGateInterventions !== undefined) {
    parsed.falseGateInterventions = boundedInteger(
      run.falseGateInterventions,
      `${context}.falseGateInterventions`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (run.reconstructionSucceeded !== undefined) {
    parsed.reconstructionSucceeded = booleanValue(
      run.reconstructionSucceeded,
      `${context}.reconstructionSucceeded`,
    );
  }
  if (run.storageBytes !== undefined) {
    parsed.storageBytes = boundedInteger(
      run.storageBytes,
      `${context}.storageBytes`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (run.waivers !== undefined) {
    parsed.waivers = boundedInteger(
      run.waivers,
      `${context}.waivers`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (run.regressionsAfterRefinement !== undefined) {
    parsed.regressionsAfterRefinement = boundedInteger(
      run.regressionsAfterRefinement,
      `${context}.regressionsAfterRefinement`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (run.primaryInputTokens !== undefined) {
    parsed.primaryInputTokens = finiteNonNegative(
      run.primaryInputTokens,
      `${context}.primaryInputTokens`,
    );
  }
  if (run.primaryOutputTokens !== undefined) {
    parsed.primaryOutputTokens = finiteNonNegative(
      run.primaryOutputTokens,
      `${context}.primaryOutputTokens`,
    );
  }
  if (run.primaryCostUsd !== undefined) {
    parsed.primaryCostUsd = finiteNonNegative(
      run.primaryCostUsd,
      `${context}.primaryCostUsd`,
    );
  }
  if (run.processExitCode !== undefined) {
    parsed.processExitCode = boundedInteger(
      run.processExitCode,
      `${context}.processExitCode`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (run.verifierExitCode !== undefined) {
    parsed.verifierExitCode = boundedInteger(
      run.verifierExitCode,
      `${context}.verifierExitCode`,
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (run.errorHash !== undefined) {
    parsed.errorHash = contentHash(run.errorHash, `${context}.errorHash`);
  }
  if (parsed.success === (parsed.errorHash !== undefined)) {
    throw new TypeError(`${context} success and errorHash are inconsistent`);
  }
  return parsed;
}

async function readStoredRun(
  path: string,
  suite: EvaluationSuiteV1,
  plan: EvaluationRunPlan,
  identity: EvaluationExecutionIdentity,
): Promise<EvaluationRunV1 | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return validateStoredRun(value, suite, plan, identity);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

export async function runEvaluationSuite(
  suite: EvaluationSuiteV1,
  options: EvaluationRunnerOptions = {},
): Promise<EvaluationSuiteResult> {
  const parsedSuite = parseEvaluationSuite(suite);
  const suiteSnapshot = await snapshotEvaluationSuite(parsedSuite);
  let harnessSnapshot: EvaluationHarnessSnapshot | undefined;
  try {
    harnessSnapshot = await snapshotEvaluationHarness(options);
    const identity = await buildExecutionIdentity(
      parsedSuite,
      suiteSnapshot,
      harnessSnapshot,
      options,
    );
    const runtimeOptions: EvaluationRunnerOptions = {
      ...options,
      extensionPath: harnessSnapshot.root,
      hardeningConfigPath: join(harnessSnapshot.root, "config", "hardened.yml"),
    };
    const defaultRoot = join(
      resolveHarnessPaths().stateRoot,
      "evaluations",
      parsedSuite.id,
      identity.executionHash.slice(7, 23),
    );
    const outputRoot = resolve(options.outputRoot ?? defaultRoot);
    const runsRoot = join(outputRoot, "runs");
    await ensurePrivateDirectory(runsRoot);
    const runs: EvaluationRunV1[] = [];
    for (const plan of planEvaluationRuns(suiteSnapshot.suite)) {
      const resultPath = join(runsRoot, `${plan.id}.json`);
      const existing = await readStoredRun(
        resultPath,
        parsedSuite,
        plan,
        identity,
      );
      if (existing) {
        runs.push(existing);
        continue;
      }
      const runRoot = join(outputRoot, "runtime", plan.id);
      await rm(runRoot, { recursive: true, force: true });
      await ensurePrivateDirectory(runRoot);
      const result = await executeEvaluationRun(
        suiteSnapshot.suite,
        plan,
        identity,
        runRoot,
        runtimeOptions,
      );
      await writePrivateAtomic(resultPath, `${canonicalJson(result)}\n`);
      runs.push(result);
    }
    const report = summarizeEvaluationRuns(
      parsedSuite,
      runs,
      identity,
      options.clock ?? Date.now,
    );
    const reportPath = join(outputRoot, "report.json");
    await writePrivateAtomic(reportPath, `${canonicalJson(report)}\n`);
    return { report, runs, outputRoot, reportPath };
  } finally {
    if (harnessSnapshot) {
      await rm(harnessSnapshot.root, { recursive: true, force: true });
    }
    await rm(suiteSnapshot.root, { recursive: true, force: true });
  }
}

export async function loadEvaluationSuite(
  path: string,
): Promise<EvaluationSuiteV1> {
  const absolutePath = resolve(path);
  const value: unknown = JSON.parse(await readFile(absolutePath, "utf8"));
  return parseEvaluationSuite(value, dirname(absolutePath));
}
