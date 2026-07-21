import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  assertNonEmptyString,
  canonicalJson,
  cloneJson,
  hashJson,
  newId,
} from "./canonical.ts";
import { writePrivateAtomic } from "./paths.ts";
import type {
  JsonObject,
  JsonValue,
  ReplayRecordV1,
  StateGraphModelV1,
  StateGraphTransitionV1,
} from "./types.ts";

const MAX_STATES = 256;
const MAX_TRANSITIONS = 1_024;
const MAX_OBSERVATION_BYTES = 64_000;

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const table: Record<string, true> = {};
  for (const key of allowed) table[key] = true;
  for (const key of Object.keys(value))
    if (!table[key])
      throw new TypeError(`${context} contains unknown field ${key}`);
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${context} must be an object`);
  return value as Record<string, unknown>;
}

export function validateStateGraphModel(value: unknown): StateGraphModelV1 {
  const model = asObject(value, "state graph model");
  assertExactKeys(
    model,
    [
      "version",
      "kind",
      "id",
      "label",
      "initialState",
      "states",
      "transitions",
      "goalStates",
      "createdAt",
      "updatedAt",
    ],
    "state graph model",
  );
  if (model.version !== 1 || model.kind !== "state_graph_model")
    throw new TypeError("Unsupported state graph model contract");
  assertNonEmptyString(model.id, "model.id", 200);
  assertNonEmptyString(model.label, "model.label", 500);
  assertNonEmptyString(model.initialState, "model.initialState", 200);
  const states = asObject(model.states, "model.states") as Record<
    string,
    JsonValue
  >;
  const stateNames = Object.keys(states);
  if (stateNames.length === 0 || stateNames.length > MAX_STATES)
    throw new TypeError(`model.states must contain 1-${MAX_STATES} states`);
  const stateLookup: Record<string, true> = {};
  const observationHashes = new Set<string>();
  for (const name of stateNames) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name))
      throw new TypeError(`Invalid state name ${name}`);
    const encoded = canonicalJson(states[name]);
    if (encoded.length > MAX_OBSERVATION_BYTES)
      throw new TypeError(
        `State ${name} observation exceeds ${MAX_OBSERVATION_BYTES} bytes`,
      );
    const hash = hashJson(states[name]);
    if (observationHashes.has(hash))
      throw new TypeError(
        `State ${name} duplicates another rendered observation, making reconstruction ambiguous`,
      );
    observationHashes.add(hash);
    stateLookup[name] = true;
  }
  if (!stateLookup[model.initialState])
    throw new TypeError("model.initialState does not exist");
  if (
    !Array.isArray(model.transitions) ||
    model.transitions.length > MAX_TRANSITIONS
  )
    throw new TypeError(
      `model.transitions must contain at most ${MAX_TRANSITIONS} items`,
    );
  const transitionKeys = new Set<string>();
  const transitions = model.transitions.map((raw, index) => {
    const transition = asObject(raw, `model.transitions[${index}]`);
    assertExactKeys(
      transition,
      ["from", "action", "to"],
      `model.transitions[${index}]`,
    );
    assertNonEmptyString(transition.from, `transition[${index}].from`, 100);
    assertNonEmptyString(transition.action, `transition[${index}].action`, 200);
    assertNonEmptyString(transition.to, `transition[${index}].to`, 100);
    if (!stateLookup[transition.from] || !stateLookup[transition.to])
      throw new TypeError(`Transition ${index} references an unknown state`);
    const key = `${transition.from}\u0000${transition.action}`;
    if (transitionKeys.has(key))
      throw new TypeError(
        `Transition ${index} duplicates state/action ${transition.from}/${transition.action}`,
      );
    transitionKeys.add(key);
    return {
      from: transition.from,
      action: transition.action,
      to: transition.to,
    };
  });
  if (!Array.isArray(model.goalStates))
    throw new TypeError("model.goalStates must be an array");
  const goalSeen = new Set<string>();
  const goalStates = model.goalStates.map((goal, index) => {
    assertNonEmptyString(goal, `goalStates[${index}]`, 100);
    if (!stateLookup[goal])
      throw new TypeError(`Goal state ${goal} does not exist`);
    if (goalSeen.has(goal)) throw new TypeError(`Duplicate goal state ${goal}`);
    goalSeen.add(goal);
    return goal;
  });
  assertNonEmptyString(model.createdAt, "model.createdAt", 100);
  assertNonEmptyString(model.updatedAt, "model.updatedAt", 100);
  return {
    version: 1,
    kind: "state_graph_model",
    id: model.id,
    label: model.label,
    initialState: model.initialState,
    states: cloneJson(states),
    transitions,
    goalStates,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

export function createStateGraphModel(
  input: {
    id?: string;
    label: string;
    initialState: string;
    states: Record<string, JsonValue>;
    transitions: StateGraphTransitionV1[];
    goalStates: string[];
  },
  options: { now?: string; idFactory?: (prefix: string) => string } = {},
): StateGraphModelV1 {
  const now = options.now ?? new Date().toISOString();
  return validateStateGraphModel({
    version: 1,
    kind: "state_graph_model",
    id: input.id?.trim() || (options.idFactory ?? newId)("model"),
    label: input.label,
    initialState: input.initialState,
    states: input.states,
    transitions: input.transitions,
    goalStates: input.goalStates,
    createdAt: now,
    updatedAt: now,
  });
}

export function reconstructState(
  model: StateGraphModelV1,
  observation: JsonValue,
): string {
  const target = hashJson(observation);
  const matches = Object.entries(model.states).filter(
    ([, rendered]) => hashJson(rendered) === target,
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length === 0
        ? "Observation does not match any model state"
        : "Observation maps to multiple model states",
    );
  return matches[0][0];
}

export function stepStateGraph(
  model: StateGraphModelV1,
  state: string,
  action: string,
): string {
  if (!(state in model.states)) throw new TypeError(`Unknown state ${state}`);
  assertNonEmptyString(action, "action", 200);
  const transition = model.transitions.find(
    (candidate) => candidate.from === state && candidate.action === action,
  );
  if (!transition) throw new Error(`No transition for ${state}/${action}`);
  return transition.to;
}

export function renderState(
  model: StateGraphModelV1,
  state: string,
): JsonValue {
  if (!(state in model.states)) throw new TypeError(`Unknown state ${state}`);
  return cloneJson(model.states[state]);
}

export function planStateGraph(
  model: StateGraphModelV1,
  fromState: string,
  requestedGoal?: string,
): string[] {
  if (!(fromState in model.states))
    throw new TypeError(`Unknown state ${fromState}`);
  const goals =
    requestedGoal === undefined
      ? new Set(model.goalStates)
      : new Set([requestedGoal]);
  for (const goal of goals)
    if (!(goal in model.states))
      throw new TypeError(`Unknown goal state ${goal}`);
  if (goals.has(fromState)) return [];
  const queue: Array<{ state: string; actions: string[] }> = [
    { state: fromState, actions: [] },
  ];
  const visited = new Set([fromState]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    for (const transition of model.transitions.filter(
      (candidate) => candidate.from === current.state,
    )) {
      if (visited.has(transition.to)) continue;
      const actions = [...current.actions, transition.action];
      if (goals.has(transition.to)) return actions;
      visited.add(transition.to);
      queue.push({ state: transition.to, actions });
    }
  }
  throw new Error("No path reaches the requested goal");
}

export function verifyReplay(
  model: StateGraphModelV1,
  input: {
    fromObservation: JsonValue;
    action: string;
    actualObservation: JsonValue;
  },
  options: { now?: string; idFactory?: (prefix: string) => string } = {},
): ReplayRecordV1 {
  const fromState = reconstructState(model, input.fromObservation);
  const predictedState = stepStateGraph(model, fromState, input.action);
  const predicted = renderState(model, predictedState);
  const matched = hashJson(predicted) === hashJson(input.actualObservation);
  return {
    version: 1,
    kind: "replay_record",
    id: (options.idFactory ?? newId)("replay"),
    modelId: model.id,
    fromState,
    action: input.action,
    predictedState,
    actualObservationHash: hashJson(input.actualObservation),
    matched,
    occurredAt: options.now ?? new Date().toISOString(),
  };
}

export function simplifyStateGraph(
  model: StateGraphModelV1,
  records: readonly ReplayRecordV1[],
  now = new Date().toISOString(),
): StateGraphModelV1 {
  const reachable = new Set([model.initialState]);
  const queue = [model.initialState];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const transition of model.transitions.filter(
      (candidate) => candidate.from === queue[cursor],
    )) {
      if (reachable.has(transition.to)) continue;
      reachable.add(transition.to);
      queue.push(transition.to);
    }
  }
  for (const record of records.filter(
    (candidate) => candidate.modelId === model.id,
  )) {
    if (!record.matched)
      throw new Error(`Cannot simplify: replay ${record.id} already diverges`);
    if (
      !reachable.has(record.fromState) ||
      !reachable.has(record.predictedState)
    )
      throw new Error(`Cannot simplify without dropping replay ${record.id}`);
  }
  const states: Record<string, JsonValue> = {};
  for (const [name, observation] of Object.entries(model.states))
    if (reachable.has(name)) states[name] = cloneJson(observation);
  return validateStateGraphModel({
    ...model,
    states,
    transitions: model.transitions.filter(
      (transition) =>
        reachable.has(transition.from) && reachable.has(transition.to),
    ),
    goalStates: model.goalStates.filter((goal) => reachable.has(goal)),
    updatedAt: now,
  });
}

function modelPath(root: string, hash: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash))
    throw new TypeError("Invalid model content hash");
  const hex = hash.slice(7);
  return join(root, hex.slice(0, 2), `${hex}.json`);
}

export async function persistStateGraphModel(
  root: string,
  model: StateGraphModelV1,
): Promise<string> {
  const validated = validateStateGraphModel(model);
  const hash = hashJson(validated);
  const path = modelPath(root, hash);
  try {
    const existing = await readFile(path, "utf8");
    if (hashJson(JSON.parse(existing)) !== hash)
      throw new Error("Existing model blob does not match its address");
    return hash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writePrivateAtomic(path, validated as unknown as JsonObject);
  return hash;
}

export async function restoreStateGraphModel(
  root: string,
  hash: string,
): Promise<StateGraphModelV1> {
  const model = validateStateGraphModel(
    JSON.parse(await readFile(modelPath(root, hash), "utf8")),
  );
  if (hashJson(model) !== hash)
    throw new TypeError(
      "State graph model failed content-address verification",
    );
  return model;
}
