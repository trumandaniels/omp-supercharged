import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, hashJson } from "./canonical.ts";
import type {
  EvaluationPolicyV1,
  ProjectPolicyV1,
  RefinerPolicyV1,
  RefinerTrigger,
  VerificationPolicyV1,
} from "./types.ts";

const DEFAULT_VERIFICATION_PATTERNS = [
  "^bun test(?:\\s|$)",
  "^bun run (?:test|check|typecheck|lint|build)(?:\\s|$)",
  "^node(?:\\s+--[A-Za-z0-9-]+(?:=[^\\s]+)?)*\\s+--test(?:\\s|$)",
  "^sfw-npm (?:test|run (?:test|check|typecheck|lint|build))(?:\\s|$)",
  "^pytest(?:\\s|$)",
  "^python(?:3)? -m pytest(?:\\s|$)",
  "^go (?:test|vet)(?:\\s|$)",
  "^sfw cargo (?:test|check|clippy)(?:\\s|$)",
  "^omp plugin doctor(?:\\s|$)",
];

const DEFAULT_MUTATION_PATTERNS = [
  "^(?:biome|prettier|eslint)(?:\\s|$).*?(?:--write|--fix)(?:\\s|$)",
  "^git (?:apply|checkout|restore|reset|clean)(?:\\s|$)",
];

export const DEFAULT_PROJECT_POLICY: ProjectPolicyV1 = {
  version: 1,
  verification: {
    commandPatterns: DEFAULT_VERIFICATION_PATTERNS,
    mutationCommandPatterns: DEFAULT_MUTATION_PATTERNS,
    ignoreCommandPatterns: [],
    maxStopContinuations: 1,
  },
  refiner: {
    enabled: false,
    autoActivate: false,
    model: "@smol",
    thinkingLevel: "low",
    triggers: [],
    maxRuns: 2,
    maxInputTokens: 3_000,
    maxOutputTokens: 1_500,
    maxRuntimeMs: 30_000,
    stagnationActionLimit: 20,
    repeatedFailureLimit: 3,
  },
  evaluation: { condition: "ledger" },
};

export interface LoadedProjectPolicy {
  policy: ProjectPolicyV1;
  policyHash: string;
  path: string;
  error?: string;
}

function assertObject(
  value: unknown,
  context: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${context} must be an object`);
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new TypeError(`${context} contains unknown field ${key}`);
}

function parseBoundedInteger(
  value: unknown,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new TypeError(
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value as number;
}

function validatePattern(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    throw new TypeError(
      `${field} must be a non-empty pattern of at most 512 characters`,
    );
  if (!value.startsWith("^"))
    throw new TypeError(`${field} must be anchored at the start with ^`);
  try {
    new RegExp(value, "u");
  } catch (error) {
    throw new TypeError(
      `${field} is not a valid regular expression: ${String(error)}`,
    );
  }
  return value;
}

function parsePatterns(
  value: unknown,
  fallback: readonly string[],
  field: string,
): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value.map((pattern, index) =>
    validatePattern(pattern, `${field}[${index}]`),
  );
}

function parseVerification(value: unknown): VerificationPolicyV1 {
  if (value === undefined)
    return structuredClone(DEFAULT_PROJECT_POLICY.verification);
  assertObject(value, "verification");
  assertKeys(
    value,
    [
      "commandPatterns",
      "mutationCommandPatterns",
      "ignoreCommandPatterns",
      "maxStopContinuations",
    ],
    "verification",
  );
  return {
    commandPatterns: parsePatterns(
      value.commandPatterns,
      DEFAULT_PROJECT_POLICY.verification.commandPatterns,
      "verification.commandPatterns",
    ),
    mutationCommandPatterns: parsePatterns(
      value.mutationCommandPatterns,
      DEFAULT_PROJECT_POLICY.verification.mutationCommandPatterns,
      "verification.mutationCommandPatterns",
    ),
    ignoreCommandPatterns: parsePatterns(
      value.ignoreCommandPatterns,
      [],
      "verification.ignoreCommandPatterns",
    ),
    maxStopContinuations: parseBoundedInteger(
      value.maxStopContinuations,
      DEFAULT_PROJECT_POLICY.verification.maxStopContinuations,
      "verification.maxStopContinuations",
      0,
      3,
    ),
  };
}

function parseRefiner(value: unknown): RefinerPolicyV1 {
  if (value === undefined)
    return structuredClone(DEFAULT_PROJECT_POLICY.refiner);
  assertObject(value, "refiner");
  assertKeys(
    value,
    [
      "enabled",
      "autoActivate",
      "model",
      "thinkingLevel",
      "triggers",
      "maxRuns",
      "maxInputTokens",
      "maxOutputTokens",
      "maxRuntimeMs",
      "stagnationActionLimit",
      "repeatedFailureLimit",
    ],
    "refiner",
  );
  const enabledInput = value.enabled;
  const autoActivateInput = value.autoActivate;
  const modelInput = value.model;
  const thinkingInput = value.thinkingLevel;
  const triggersInput = value.triggers;
  let enabled = DEFAULT_PROJECT_POLICY.refiner.enabled;
  if (enabledInput !== undefined) {
    if (typeof enabledInput !== "boolean")
      throw new TypeError("refiner.enabled must be boolean");
    enabled = enabledInput;
  }
  let autoActivate = DEFAULT_PROJECT_POLICY.refiner.autoActivate;
  if (autoActivateInput !== undefined) {
    if (typeof autoActivateInput !== "boolean")
      throw new TypeError("refiner.autoActivate must be boolean");
    autoActivate = autoActivateInput;
  }
  if (
    modelInput !== undefined &&
    (typeof modelInput !== "string" || modelInput.trim().length === 0)
  )
    throw new TypeError("refiner.model must be non-empty");
  let thinkingLevel = DEFAULT_PROJECT_POLICY.refiner.thinkingLevel;
  if (thinkingInput !== undefined) {
    if (
      thinkingInput !== "minimal" &&
      thinkingInput !== "low" &&
      thinkingInput !== "medium" &&
      thinkingInput !== "high"
    ) {
      throw new TypeError("refiner.thinkingLevel is invalid");
    }
    thinkingLevel = thinkingInput;
  }
  let triggers = [...DEFAULT_PROJECT_POLICY.refiner.triggers];
  if (triggersInput !== undefined) {
    if (!Array.isArray(triggersInput))
      throw new TypeError("refiner.triggers must be an array");
    const seen = new Set<RefinerTrigger>();
    triggers = triggersInput.map((trigger, index) => {
      if (
        trigger !== "verification_failure" &&
        trigger !== "repeated_tool_failure" &&
        trigger !== "budget_stagnation" &&
        trigger !== "successful_milestone" &&
        trigger !== "belief_contradiction"
      ) {
        throw new TypeError(`refiner.triggers[${index}] is invalid`);
      }
      if (seen.has(trigger))
        throw new TypeError(`refiner.triggers contains duplicate ${trigger}`);
      seen.add(trigger);
      return trigger;
    });
  }
  return {
    enabled,
    autoActivate,
    model:
      typeof modelInput === "string"
        ? modelInput.trim()
        : DEFAULT_PROJECT_POLICY.refiner.model,
    thinkingLevel,
    triggers,
    maxRuns: parseBoundedInteger(
      value.maxRuns,
      DEFAULT_PROJECT_POLICY.refiner.maxRuns,
      "refiner.maxRuns",
      1,
      10,
    ),
    maxInputTokens: parseBoundedInteger(
      value.maxInputTokens,
      DEFAULT_PROJECT_POLICY.refiner.maxInputTokens,
      "refiner.maxInputTokens",
      256,
      16_000,
    ),
    maxOutputTokens: parseBoundedInteger(
      value.maxOutputTokens,
      DEFAULT_PROJECT_POLICY.refiner.maxOutputTokens,
      "refiner.maxOutputTokens",
      128,
      8_000,
    ),
    maxRuntimeMs: parseBoundedInteger(
      value.maxRuntimeMs,
      DEFAULT_PROJECT_POLICY.refiner.maxRuntimeMs,
      "refiner.maxRuntimeMs",
      1_000,
      120_000,
    ),
    stagnationActionLimit: parseBoundedInteger(
      value.stagnationActionLimit,
      DEFAULT_PROJECT_POLICY.refiner.stagnationActionLimit,
      "refiner.stagnationActionLimit",
      5,
      200,
    ),
    repeatedFailureLimit: parseBoundedInteger(
      value.repeatedFailureLimit,
      DEFAULT_PROJECT_POLICY.refiner.repeatedFailureLimit,
      "refiner.repeatedFailureLimit",
      2,
      20,
    ),
  };
}

function parseEvaluation(value: unknown): EvaluationPolicyV1 {
  if (value === undefined)
    return structuredClone(DEFAULT_PROJECT_POLICY.evaluation);
  assertObject(value, "evaluation");
  assertKeys(value, ["condition", "taskId"], "evaluation");
  const condition =
    value.condition ?? DEFAULT_PROJECT_POLICY.evaluation.condition;
  if (
    condition !== "stock" &&
    condition !== "ledger" &&
    condition !== "state" &&
    condition !== "refiner" &&
    condition !== "executable_model"
  ) {
    throw new TypeError("evaluation.condition is invalid");
  }
  const taskId = value.taskId;
  if (taskId === undefined) return { condition };
  if (
    typeof taskId !== "string" ||
    taskId.trim().length === 0 ||
    taskId.length > 200
  ) {
    throw new TypeError(
      "evaluation.taskId must be a non-empty string of at most 200 characters",
    );
  }
  return { condition, taskId: taskId.trim() };
}

export function parseProjectPolicy(value: unknown): ProjectPolicyV1 {
  assertObject(value, "project policy");
  assertKeys(
    value,
    ["version", "verification", "refiner", "evaluation"],
    "project policy",
  );
  if (value.version !== 1)
    throw new TypeError("Project policy version must be 1");
  return {
    version: 1,
    verification: parseVerification(value.verification),
    refiner: parseRefiner(value.refiner),
    evaluation: parseEvaluation(value.evaluation),
  };
}

export async function loadProjectPolicy(
  cwd: string,
): Promise<LoadedProjectPolicy> {
  const path = join(cwd, ".omp", "supercharged.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const policy = structuredClone(DEFAULT_PROJECT_POLICY);
      return { policy, policyHash: hashJson(policy), path };
    }
    const policy = structuredClone(DEFAULT_PROJECT_POLICY);
    return {
      policy,
      policyHash: hashJson(policy),
      path,
      error: `Cannot read project policy: ${String(error)}`,
    };
  }
  try {
    const policy = parseProjectPolicy(JSON.parse(raw));
    return { policy, policyHash: hashJson(policy), path };
  } catch (error) {
    const policy = structuredClone(DEFAULT_PROJECT_POLICY);
    return {
      policy,
      policyHash: hashJson(policy),
      path,
      error: `Invalid project policy; using complete built-in defaults: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function formatPolicy(policy: ProjectPolicyV1): string {
  return canonicalJson(policy);
}
