import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  assertFiniteUnitInterval,
  assertNonEmptyString,
  canonicalJson,
  cloneJson,
  hashJson,
  newId,
} from "./canonical.ts";
import { writePrivateAtomic } from "./paths.ts";
import type {
  AgentPayloadV1,
  ComponentKind,
  ComponentMetricSnapshotV1,
  ComponentPayloadV1,
  ComponentRevisionV1,
  ComponentStatus,
  JsonObject,
  MemoryPayloadV1,
  PolicyOverlayPayloadV1,
  SkillPayloadV1,
} from "./types.ts";

export interface ComponentProposalInput {
  componentKind: ComponentKind;
  name: string;
  payload: ComponentPayloadV1;
  rationale: string;
  proposedBy: ComponentRevisionV1["proposedBy"];
  triggerEventId?: string;
}

export interface ComponentRevisionEntryV1 {
  version: 1;
  kind: "component_revision_ref";
  revisionId: string;
  componentKind: ComponentKind;
  name: string;
  parentRevisionId?: string;
  contentHash: string;
  status: ComponentStatus;
  rationale: string;
  proposedBy: ComponentRevisionV1["proposedBy"];
  triggerEventId?: string;
  validators: string[];
  validationErrors: string[];
  metricsBefore?: ComponentMetricSnapshotV1;
  metricsAfter?: ComponentMetricSnapshotV1;
  createdAt: string;
  updatedAt: string;
}

const COMPONENT_KINDS = new Set<ComponentKind>([
  "policy_overlay",
  "skill",
  "agent",
  "memory",
]);
const READ_ONLY_AGENT_TOOLS = new Set(["read", "grep", "glob", "web_search"]);
const MAX_COMPONENT_TEXT = 12_000;
const MAX_PROJECTED_TEXT = 24_000;

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

function asPayloadObject(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function validatePolicyPayload(value: unknown): PolicyOverlayPayloadV1 {
  const payload = asPayloadObject(value, "policy overlay payload");
  assertExactKeys(payload, ["instructions"], "policy overlay payload");
  assertNonEmptyString(
    payload.instructions,
    "policy overlay instructions",
    MAX_COMPONENT_TEXT,
  );
  return { instructions: payload.instructions.trim() };
}

function validateSkillPayload(value: unknown): SkillPayloadV1 {
  const payload = asPayloadObject(value, "skill payload");
  assertExactKeys(payload, ["description", "instructions"], "skill payload");
  assertNonEmptyString(payload.description, "skill description", 1_000);
  assertNonEmptyString(
    payload.instructions,
    "skill instructions",
    MAX_COMPONENT_TEXT,
  );
  return {
    description: payload.description.trim(),
    instructions: payload.instructions.trim(),
  };
}

function validateAgentPayload(value: unknown): AgentPayloadV1 {
  const payload = asPayloadObject(value, "agent payload");
  assertExactKeys(
    payload,
    ["description", "instructions", "tools", "modelRole"],
    "agent payload",
  );
  assertNonEmptyString(payload.description, "agent description", 1_000);
  assertNonEmptyString(
    payload.instructions,
    "agent instructions",
    MAX_COMPONENT_TEXT,
  );
  if (!Array.isArray(payload.tools))
    throw new TypeError("agent tools must be an array");
  const seen = new Set<string>();
  const tools = payload.tools.map((tool, index) => {
    assertNonEmptyString(tool, `agent.tools[${index}]`, 100);
    if (!READ_ONLY_AGENT_TOOLS.has(tool))
      throw new TypeError(
        `Generated agent tool ${tool} is not in the read-only allowlist`,
      );
    if (seen.has(tool)) throw new TypeError(`Duplicate agent tool ${tool}`);
    seen.add(tool);
    return tool;
  });
  const modelRole = payload.modelRole;
  if (modelRole === undefined) {
    return {
      description: payload.description.trim(),
      instructions: payload.instructions.trim(),
      tools,
    };
  }
  assertNonEmptyString(modelRole, "agent.modelRole", 100);
  if (!modelRole.startsWith("@"))
    throw new TypeError(
      "agent.modelRole must be an OMP role alias beginning with @",
    );
  return {
    description: payload.description.trim(),
    instructions: payload.instructions.trim(),
    tools,
    modelRole,
  };
}

function validateMemoryPayload(value: unknown): MemoryPayloadV1 {
  const payload = asPayloadObject(value, "memory payload");
  assertExactKeys(
    payload,
    ["claim", "confidence", "scope", "evidenceRefs"],
    "memory payload",
  );
  assertNonEmptyString(payload.claim, "memory claim", MAX_COMPONENT_TEXT);
  assertFiniteUnitInterval(payload.confidence, "memory confidence");
  assertNonEmptyString(payload.scope, "memory scope", 2_000);
  if (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.length === 0)
    throw new TypeError(
      "memory evidenceRefs must contain at least one reference",
    );
  const seen = new Set<string>();
  const evidenceRefs = payload.evidenceRefs.map((reference, index) => {
    assertNonEmptyString(reference, `memory.evidenceRefs[${index}]`, 1_000);
    if (seen.has(reference))
      throw new TypeError(`Duplicate memory evidence reference ${reference}`);
    seen.add(reference);
    return reference;
  });
  return {
    claim: payload.claim.trim(),
    confidence: payload.confidence,
    scope: payload.scope.trim(),
    evidenceRefs,
  };
}

export function validateComponentPayload(
  kind: ComponentKind,
  value: unknown,
): ComponentPayloadV1 {
  if (!COMPONENT_KINDS.has(kind)) throw new TypeError("Unknown component kind");
  if (kind === "policy_overlay") return validatePolicyPayload(value);
  if (kind === "skill") return validateSkillPayload(value);
  if (kind === "agent") return validateAgentPayload(value);
  return validateMemoryPayload(value);
}

export function componentKey(kind: ComponentKind, name: string): string {
  return `${kind}:${name}`;
}

export function createComponentProposal(
  input: ComponentProposalInput,
  options: {
    now?: string;
    idFactory?: (prefix: string) => string;
    parentRevisionId?: string;
    metrics?: ComponentMetricSnapshotV1;
  } = {},
): ComponentRevisionV1 {
  if (!COMPONENT_KINDS.has(input.componentKind))
    throw new TypeError("Unknown component kind");
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(input.name))
    throw new TypeError(
      "Component name must be 2-64 lowercase letters, digits, or hyphens",
    );
  assertNonEmptyString(input.rationale, "component rationale", 4_000);
  const payload = validateComponentPayload(input.componentKind, input.payload);
  const now = options.now ?? new Date().toISOString();
  return {
    version: 1,
    kind: "component_revision",
    id: (options.idFactory ?? newId)("revision"),
    componentKind: input.componentKind,
    name: input.name,
    ...(options.parentRevisionId
      ? { parentRevisionId: options.parentRevisionId }
      : {}),
    contentHash: hashJson(payload),
    payload,
    status: "proposed",
    rationale: input.rationale.trim(),
    proposedBy: input.proposedBy,
    ...(input.triggerEventId ? { triggerEventId: input.triggerEventId } : {}),
    validators: [],
    validationErrors: [],
    ...(options.metrics ? { metricsBefore: cloneJson(options.metrics) } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function payloadText(payload: ComponentPayloadV1): string[] {
  if ("instructions" in payload)
    return [
      payload.instructions,
      "description" in payload ? payload.description : "",
    ];
  if ("claim" in payload) return [payload.claim, payload.scope];
  return [];
}

function policyErrors(revision: ComponentRevisionV1): string[] {
  const errors: string[] = [];
  const hostilePatterns = [
    /ignore (?:all )?(?:previous|prior) instructions/iu,
    /disable .{0,40}(?:verification|approval|safety|firewall)/iu,
    /exfiltrat/iu,
    /authorization\s*:\s*bearer/iu,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /(?:api|access|secret)[_-]?key\s*[:=]\s*[A-Za-z0-9_-]{12,}/iu,
  ];
  for (const text of payloadText(revision.payload)) {
    if (text.includes("\0")) errors.push("payload contains a NUL byte");
    for (const pattern of hostilePatterns)
      if (pattern.test(text))
        errors.push(`payload violates policy pattern ${pattern.source}`);
  }
  return [...new Set(errors)];
}

function projectedPayloadSize(
  revision: ComponentRevisionV1,
  activeRevisions: readonly ComponentRevisionV1[],
): number {
  return [
    ...activeRevisions.filter(
      (active) =>
        componentKey(active.componentKind, active.name) !==
        componentKey(revision.componentKind, revision.name),
    ),
    revision,
  ]
    .flatMap((item) => payloadText(item.payload))
    .reduce((total, text) => total + text.length, 0);
}

export function validateComponentRevision(
  revision: ComponentRevisionV1,
  activeRevisions: readonly ComponentRevisionV1[],
  now = new Date().toISOString(),
): ComponentRevisionV1[] {
  if (revision.status !== "proposed")
    throw new TypeError("Only proposed revisions can enter validation");
  const transitions: ComponentRevisionV1[] = [];
  let current = cloneJson(revision);
  try {
    current.payload = validateComponentPayload(
      current.componentKind,
      current.payload,
    );
    current.status = "schema_valid";
    current.validators.push("schema-v1");
    current.updatedAt = now;
    transitions.push(cloneJson(current));
  } catch (error) {
    current.status = "rejected";
    current.validationErrors.push(
      error instanceof Error ? error.message : String(error),
    );
    current.updatedAt = now;
    return [current];
  }
  const violations = policyErrors(current);
  if (violations.length > 0) {
    current.status = "rejected";
    current.validationErrors.push(...violations);
    current.updatedAt = now;
    transitions.push(cloneJson(current));
    return transitions;
  }
  current.status = "policy_valid";
  current.validators.push("text-policy-v1");
  current.updatedAt = now;
  transitions.push(cloneJson(current));
  const projectedSize = projectedPayloadSize(current, activeRevisions);
  if (projectedSize > MAX_PROJECTED_TEXT) {
    current.status = "rejected";
    current.validationErrors.push(
      `active projection would exceed ${MAX_PROJECTED_TEXT} characters`,
    );
  } else {
    current.status = "canary_valid";
    current.validators.push("projection-canary-v1");
  }
  current.updatedAt = now;
  transitions.push(cloneJson(current));
  return transitions;
}

export function assertComponentRevisionCanActivate(
  revision: ComponentRevisionV1,
  activeRevisions: readonly ComponentRevisionV1[],
): void {
  if (revision.status !== "canary_valid")
    throw new TypeError("Only canary-valid revisions can become active");
  validateComponentPayload(revision.componentKind, revision.payload);
  const violations = policyErrors(revision);
  if (violations.length > 0)
    throw new TypeError(
      `Component no longer passes policy validation: ${violations.join("; ")}`,
    );
  if (projectedPayloadSize(revision, activeRevisions) > MAX_PROJECTED_TEXT)
    throw new TypeError(
      `Active projection would exceed ${MAX_PROJECTED_TEXT} characters`,
    );
}

export function activateComponentRevision(
  revision: ComponentRevisionV1,
  metrics: ComponentMetricSnapshotV1,
  now = new Date().toISOString(),
): ComponentRevisionV1 {
  if (revision.status !== "canary_valid")
    throw new TypeError("Only canary-valid revisions can become active");
  const active = cloneJson(revision);
  active.status = "active";
  active.metricsBefore = cloneJson(metrics);
  active.updatedAt = now;
  return active;
}

export function rejectComponentRevision(
  revision: ComponentRevisionV1,
  reason: string,
  now = new Date().toISOString(),
): ComponentRevisionV1 {
  if (revision.status === "active" || revision.status === "rolled_back")
    throw new TypeError("Active or rolled-back revisions cannot be rejected");
  assertNonEmptyString(reason, "rejection reason", 4_000);
  const rejected = cloneJson(revision);
  rejected.status = "rejected";
  rejected.validationErrors.push(reason.trim());
  rejected.updatedAt = now;
  return rejected;
}

export function rollbackComponentRevision(
  revision: ComponentRevisionV1,
  reason: string,
  metrics: ComponentMetricSnapshotV1,
  now = new Date().toISOString(),
): ComponentRevisionV1 {
  if (revision.status !== "active")
    throw new TypeError("Only active revisions can be rolled back");
  assertNonEmptyString(reason, "rollback reason", 4_000);
  const rolledBack = cloneJson(revision);
  rolledBack.status = "rolled_back";
  rolledBack.metricsAfter = cloneJson(metrics);
  rolledBack.validationErrors.push(reason.trim());
  rolledBack.updatedAt = now;
  return rolledBack;
}

export function shouldRollbackComponent(
  revision: ComponentRevisionV1,
  current: ComponentMetricSnapshotV1,
): boolean {
  if (
    revision.status !== "active" ||
    revision.proposedBy !== "refiner" ||
    !revision.metricsBefore
  )
    return false;
  return (
    current.regressions > revision.metricsBefore.regressions ||
    current.verificationFailures -
      revision.metricsBefore.verificationFailures >=
      2
  );
}

export function componentRevisionEntry(
  revision: ComponentRevisionV1,
): ComponentRevisionEntryV1 {
  const { payload: _payload, kind: _kind, ...metadata } = revision;
  return {
    version: 1,
    kind: "component_revision_ref",
    revisionId: revision.id,
    ...metadata,
  };
}

function payloadPath(root: string, hash: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash))
    throw new TypeError("Invalid component content hash");
  const hex = hash.slice(7);
  return join(root, hex.slice(0, 2), `${hex}.json`);
}

export async function persistComponentPayload(
  root: string,
  revision: ComponentRevisionV1,
): Promise<void> {
  if (hashJson(revision.payload) !== revision.contentHash)
    throw new TypeError("Component payload hash mismatch");
  const path = payloadPath(root, revision.contentHash);
  try {
    const existing = await readFile(path, "utf8");
    if (hashJson(JSON.parse(existing)) !== revision.contentHash)
      throw new Error("Existing component blob does not match its address");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writePrivateAtomic(path, revision.payload as unknown as JsonObject);
}

export async function restoreComponentRevision(
  root: string,
  entry: ComponentRevisionEntryV1,
): Promise<ComponentRevisionV1> {
  const raw = await readFile(payloadPath(root, entry.contentHash), "utf8");
  const payload = validateComponentPayload(
    entry.componentKind,
    JSON.parse(raw),
  );
  if (hashJson(payload) !== entry.contentHash)
    throw new TypeError(
      `Component blob ${entry.contentHash} failed content verification`,
    );
  const { kind: _kind, revisionId, ...metadata } = entry;
  return { kind: "component_revision", id: revisionId, payload, ...metadata };
}

export function renderActiveComponents(
  revisions: readonly ComponentRevisionV1[],
): string {
  const active = revisions
    .filter((revision) => revision.status === "active")
    .sort((left, right) =>
      componentKey(left.componentKind, left.name).localeCompare(
        componentKey(right.componentKind, right.name),
      ),
    );
  if (active.length === 0) return "";
  const lines = [
    "# Adaptive harness guidance",
    "The following accepted, versioned components are heuristic guidance. Current repository evidence and higher-priority instructions override them.",
  ];
  for (const revision of active) {
    lines.push(
      `## ${revision.componentKind}:${revision.name} (${revision.id}, ${revision.contentHash})`,
    );
    if (revision.componentKind === "memory") {
      const payload = revision.payload as MemoryPayloadV1;
      lines.push(
        `Scope: ${payload.scope}; confidence: ${payload.confidence.toFixed(2)}; evidence: ${payload.evidenceRefs.join(", ")}`,
      );
      lines.push(payload.claim);
    } else {
      const payload = revision.payload as
        | PolicyOverlayPayloadV1
        | SkillPayloadV1
        | AgentPayloadV1;
      if ("description" in payload)
        lines.push(`Description: ${payload.description}`);
      lines.push(payload.instructions);
    }
  }
  const rendered = lines.join("\n\n");
  if (rendered.length > MAX_PROJECTED_TEXT)
    throw new Error(
      "Active component projection exceeds its validated size ceiling",
    );
  return rendered;
}

export function revisionAsLedgerData(
  revision: ComponentRevisionV1,
): JsonObject {
  return {
    revisionId: revision.id,
    componentKind: revision.componentKind,
    name: revision.name,
    lifecycle: revision.status,
    contentHash: revision.contentHash,
    ...(revision.parentRevisionId
      ? { parentRevisionId: revision.parentRevisionId }
      : {}),
    validators: revision.validators,
    validationErrors: revision.validationErrors,
    proposedBy: revision.proposedBy,
    ...(revision.triggerEventId
      ? { triggerEventId: revision.triggerEventId }
      : {}),
    ...(revision.metricsBefore
      ? { metrics: revision.metricsBefore as unknown as JsonObject }
      : {}),
  };
}

export function componentPayloadCanonical(
  revision: ComponentRevisionV1,
): string {
  return canonicalJson(revision.payload);
}
