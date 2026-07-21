import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import {
  applyBeliefMutation,
  readBeliefs,
  renderBeliefState,
  type BeliefMutationInput,
  type BeliefReadInput,
} from "./beliefs.ts";
import { canonicalJson, cloneJson, hashJson, newId } from "./canonical.ts";
import {
  classifyToolCall,
  type ClassificationResult,
} from "./classification.ts";
import {
  activateComponentRevision,
  componentKey,
  componentRevisionEntry,
  createComponentProposal,
  persistComponentPayload,
  rejectComponentRevision,
  renderActiveComponents,
  restoreComponentRevision,
  revisionAsLedgerData,
  rollbackComponentRevision,
  shouldRollbackComponent,
  validateComponentRevision,
  type ComponentProposalInput,
  type ComponentRevisionEntryV1,
} from "./components.ts";
import {
  createStateGraphModel,
  persistStateGraphModel,
  planStateGraph,
  reconstructState,
  renderState,
  restoreStateGraphModel,
  simplifyStateGraph,
  stepStateGraph,
  verifyReplay,
} from "./executable-model.ts";
import {
  applyHypothesisMutation,
  readHypotheses,
  type HypothesisMutationInput,
  type HypothesisReadInput,
} from "./hypotheses.ts";
import { RunLedger, eventData } from "./ledger.ts";
import { deriveManifest } from "./manifest.ts";
import { resolveRunPaths, writePrivateAtomic, type RunPaths } from "./paths.ts";
import { loadProjectPolicy, type LoadedProjectPolicy } from "./policy.ts";
import {
  buildRefinerSnapshot,
  detectRefinerTriggers,
  runRefiner,
  type RefinerModelRunner,
  type RefinerProposalV1,
} from "./refiner.ts";
import {
  createInitialState,
  decideStop,
  hypothesisCounts,
  observationFromTool,
  reduceEvent,
} from "./reducer.ts";
import type {
  BeliefClaimV1,
  ComponentKind,
  ComponentMetricSnapshotV1,
  ComponentPayloadV1,
  ComponentRevisionV1,
  EvidenceRefV1,
  HarnessStateV1,
  JsonObject,
  JsonValue,
  ProjectPolicyV1,
  RefinerTrigger,
  ReplayRecordV1,
  RunEventDraftV1,
  RunEventV1,
  StateGraphModelV1,
  TransitionEffect,
  TransitionV1,
  VerificationEvidenceV1,
  VerificationWaiverV1,
} from "./types.ts";

const EXTENSION_VERSION = "0.1.0";
const HYPOTHESIS_ENTRY = "omp-supercharged-hypothesis-v1";
const BELIEF_ENTRY = "omp-supercharged-belief-v1";
const COMPONENT_ENTRY = "omp-supercharged-component-v1";
const MODEL_ENTRY = "omp-supercharged-model-v1";
const FEATURE_ORDER: Record<
  ProjectPolicyV1["evaluation"]["condition"],
  number
> = {
  stock: 0,
  ledger: 1,
  state: 2,
  refiner: 3,
  executable_model: 4,
};

interface ToolCallMetadata {
  startedAt: number;
  inputHash: string;
  classification: ClassificationResult;
  observationBefore: HarnessStateV1["lastObservationRef"];
}

interface HypothesisSessionEntryV1 {
  version: 1;
  kind: "hypothesis_state";
  ledgerEventId: string;
  operation: string;
  hypothesis: HarnessStateV1["hypotheses"][string];
}

interface BeliefSessionEntryV1 {
  version: 1;
  kind: "belief_state";
  ledgerEventId: string;
  operation: string;
  claim: BeliefClaimV1;
}

interface ModelSessionEntryV1 {
  version: 1;
  kind: "state_graph_model_ref";
  ledgerEventId: string;
  operation: "register" | "simplify" | "replay";
  modelId: string;
  contentHash: string;
  replay?: ReplayRecordV1;
}

function safeError(error: unknown): string {
  const source =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return source
    .replace(/authorization\s*:\s*bearer\s+\S+/giu, "authorization: [redacted]")
    .replace(
      /(?:api|access|secret)[_-]?key\s*[:=]\s*\S+/giu,
      "credential=[redacted]",
    )
    .slice(0, 1_000);
}

function toolResult(
  value: JsonValue,
  isError = false,
): {
  content: Array<{ type: "text"; text: string }>;
  details: JsonValue;
  isError?: boolean;
} {
  const result: {
    content: Array<{ type: "text"; text: string }>;
    details: JsonValue;
    isError?: boolean;
  } = {
    content: [{ type: "text", text: canonicalJson(value) }],
    details: value,
  };
  if (isError) result.isError = true;
  return result;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function assistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object" || Array.isArray(message))
      continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    if (typeof record.content === "string") return record.content;
    if (!Array.isArray(record.content)) continue;
    const text = record.content
      .filter(
        (block) =>
          block &&
          typeof block === "object" &&
          !Array.isArray(block) &&
          (block as Record<string, unknown>).type === "text",
      )
      .map((block) => (block as Record<string, unknown>).text)
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    if (text.length > 0) return text;
  }
  throw new Error("Refiner model returned no assistant text");
}

function parseCommandParts(args: string): string[] {
  return args.trim().split(/\s+/u).filter(Boolean);
}

export class HarnessRuntime {
  readonly pi: ExtensionAPI;
  #ledger?: RunLedger;
  #paths?: RunPaths;
  #loadedPolicy?: LoadedProjectPolicy;
  #state?: HarnessStateV1;
  #initializationError?: string;
  #toolCalls = new Map<string, ToolCallMetadata>();
  #events: RunEventV1[] = [];
  #eventIds = new Set<string>();
  #toolCallIds = new Set<string>();
  #revisions = new Map<string, ComponentRevisionV1>();
  #models = new Map<string, StateGraphModelV1>();
  #pendingRefiner?: Timer;
  #refinerInFlight = false;
  #closed = false;
  #closing = false;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  register(): void {
    this.registerLifecycle();
    this.registerCommands();
    this.registerHypothesisTool();
    this.registerBeliefTool();
    this.registerComponentTool();
    this.registerExecutableModelTool();
  }

  private registerLifecycle(): void {
    this.pi.on("session_start", async (_event, ctx) => {
      await this.initialize(ctx);
    });
    this.pi.on("before_agent_start", (_event, _ctx) => {
      if (!this.#state || !this.#loadedPolicy) return;
      const additions: string[] = [];
      if (this.hasFeature("state")) {
        const beliefs = renderBeliefState(this.#state.beliefs);
        if (beliefs)
          additions.push(`# Current harness belief state\n${beliefs}`);
      }
      if (this.hasFeature("refiner")) {
        const components = renderActiveComponents(this.activeRevisions());
        if (components) additions.push(components);
      }
      if (additions.length === 0) return;
      return {
        message: {
          customType: "omp-supercharged-context",
          content: additions.join("\n\n"),
          display: false,
        },
      };
    });
    this.pi.on("turn_start", async (event) => {
      if (!this.ready) return;
      await this.append({
        kind: "turn_started",
        status: "started",
        turnId: String(event.turnIndex),
        data: { turnIndex: event.turnIndex },
      } as RunEventDraftV1);
    });
    this.pi.on("turn_end", async (event) => {
      if (!this.ready) return;
      await this.append({
        kind: "turn_finished",
        status: "ok",
        turnId: String(event.turnIndex),
        data: {
          turnIndex: event.turnIndex,
          toolResultCount: event.toolResults.length,
        },
      } as RunEventDraftV1);
    });
    this.pi.on("tool_call", async (event) => {
      await this.handleToolCall(event);
    });
    this.pi.on("tool_result", async (event, ctx) => {
      await this.handleToolResult(event, ctx);
    });
    this.pi.on("auto_retry_start", async (event) => {
      if (!this.ready) return;
      await this.append({
        kind: "retry_started",
        status: "started",
        data: {
          eventClass: "provider_retry",
          attempt: event.attempt,
          delayMs: event.delayMs,
        },
      } as RunEventDraftV1);
    });
    this.pi.on("auto_retry_end", async (event) => {
      if (!this.ready) return;
      await this.append({
        kind: "retry_finished",
        status: event.success ? "ok" : "error",
        data: {
          eventClass: "provider_retry",
          attempt: event.attempt,
          success: event.success,
        },
      } as RunEventDraftV1);
    });
    this.pi.on("session_switch", async (event, ctx) => {
      await this.handleLineage(
        "switch",
        {
          previousSessionHash: event.previousSessionFile
            ? hashJson({ path: event.previousSessionFile })
            : "none",
        },
        ctx,
      );
    });
    this.pi.on("session_branch", async (event, ctx) => {
      await this.handleLineage(
        "branch",
        {
          previousSessionHash: event.previousSessionFile
            ? hashJson({ path: event.previousSessionFile })
            : "none",
        },
        ctx,
      );
    });
    this.pi.on("session_tree", async (event, ctx) => {
      await this.handleLineage(
        "tree",
        {
          oldLeafId: event.oldLeafId ?? "none",
          newLeafId: event.newLeafId ?? "none",
        },
        ctx,
      );
    });
    this.pi.on("session_stop", async (event) => this.handleStop(event.turn_id));
    this.pi.on("session_shutdown", async (_event, ctx) => {
      await this.shutdown(ctx);
    });
  }

  private registerCommands(): void {
    this.pi.registerCommand("harness-status", {
      description: "Show the durable harness state and verification freshness",
      handler: async (_args, ctx) => this.showStatus(ctx),
    });
    this.pi.registerCommand("harness-waive", {
      description:
        "Waive verification for the current mutation epoch with a reason",
      handler: async (args, ctx) => this.waive(args, ctx),
    });
    this.pi.registerCommand("harness-export", {
      description: "Rebuild and atomically export the current run manifest",
      handler: async (_args, ctx) => this.exportManifest(ctx),
    });
    this.pi.registerCommand("harness-refine", {
      description:
        "Run one bounded Refiner pass when the refiner ablation is enabled",
      handler: async (args, ctx) => {
        this.requireFeature("refiner", "Refiner");
        await this.runRefinement(
          "manual",
          ctx,
          undefined,
          args.trim() || undefined,
        );
      },
    });
    this.pi.registerCommand("harness-components", {
      description: "List staged and active adaptive component revisions",
      handler: async (_args, ctx) => {
        this.requireFeature("refiner", "Adaptive components");
        const rows = [...this.#revisions.values()]
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) ||
              left.id.localeCompare(right.id),
          )
          .map(
            (revision) =>
              `${revision.id}  ${revision.componentKind}:${revision.name}  ${revision.status}  ${revision.contentHash}`,
          );
        this.notify(
          ctx,
          rows.length ? rows.join("\n") : "No component revisions.",
        );
      },
    });
    this.pi.registerCommand("harness-component-accept", {
      description: "Activate a canary-valid component revision",
      handler: async (args, ctx) => {
        this.requireFeature("refiner", "Adaptive components");
        const [revisionId, ...rest] = parseCommandParts(args);
        if (!revisionId || rest.length > 0)
          throw new Error("Usage: /harness-component-accept <revision-id>");
        const revision = this.requireRevision(revisionId);
        const active = activateComponentRevision(
          revision,
          this.metricSnapshot(),
        );
        await this.persistComponentLifecycle(active);
        this.notify(
          ctx,
          `Activated ${active.componentKind}:${active.name} revision ${active.id}.`,
        );
      },
    });
    this.pi.registerCommand("harness-component-reject", {
      description: "Reject a staged component revision",
      handler: async (args, ctx) => {
        this.requireFeature("refiner", "Adaptive components");
        const [revisionId, ...reasonParts] = parseCommandParts(args);
        if (!revisionId || reasonParts.length === 0)
          throw new Error(
            "Usage: /harness-component-reject <revision-id> <reason>",
          );
        const rejected = rejectComponentRevision(
          this.requireRevision(revisionId),
          reasonParts.join(" "),
        );
        await this.persistComponentLifecycle(rejected);
        this.notify(ctx, `Rejected revision ${rejected.id}.`, "warning");
      },
    });
    this.pi.registerCommand("harness-component-rollback", {
      description: "Roll back an active component revision",
      handler: async (args, ctx) => {
        this.requireFeature("refiner", "Adaptive components");
        const [revisionId, ...reasonParts] = parseCommandParts(args);
        if (!revisionId || reasonParts.length === 0)
          throw new Error(
            "Usage: /harness-component-rollback <revision-id> <reason>",
          );
        const rolledBack = rollbackComponentRevision(
          this.requireRevision(revisionId),
          reasonParts.join(" "),
          this.metricSnapshot(),
        );
        await this.persistComponentLifecycle(rolledBack);
        this.notify(ctx, `Rolled back revision ${rolledBack.id}.`, "warning");
      },
    });
  }

  private registerHypothesisTool(): void {
    const z = this.pi.zod;
    const verifiedEvidence = z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("run_event"),
          ref: z.string().min(1).max(1_000),
          note: z.string().max(2_000).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("tool_call"),
          ref: z.string().min(1).max(1_000),
          note: z.string().max(2_000).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("artifact"),
          ref: z.string().min(1).max(1_000),
          note: z.string().max(2_000).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("unverified_note"),
          ref: z.string().min(1).max(1_000),
          note: z.string().min(1).max(2_000),
        })
        .strict(),
    ]);
    const prediction = z
      .object({
        id: z.string().min(1).max(200),
        description: z.string().min(1).max(4_000),
        observable: z.string().min(1).max(4_000),
      })
      .strict();
    const falsificationTest = z
      .object({
        description: z.string().min(1).max(8_000),
        estimatedCost: z
          .record(z.string(), z.number().finite().nonnegative())
          .optional(),
        risk: z.enum(["read-only", "reversible", "irreversible"]).optional(),
      })
      .strict();
    const parameters = z.discriminatedUnion("operation", [
      z
        .object({
          operation: z.literal("create"),
          id: z.string().min(1).max(200).optional(),
          mechanism: z.string().min(1).max(16_000),
          confidence: z.number().finite().min(0).max(1),
          status: z.enum(["live", "deferred"]).optional(),
        })
        .strict(),
      z
        .object({
          operation: z.literal("add_evidence"),
          id: z.string().min(1).max(200),
          side: z.enum(["for", "against"]),
          evidence: verifiedEvidence,
        })
        .strict(),
      z
        .object({
          operation: z.literal("add_prediction"),
          id: z.string().min(1).max(200),
          prediction,
        })
        .strict(),
      z
        .object({
          operation: z.literal("set_falsification_test"),
          id: z.string().min(1).max(200),
          test: falsificationTest,
        })
        .strict(),
      z
        .object({
          operation: z.literal("set_confidence"),
          id: z.string().min(1).max(200),
          confidence: z.number().finite().min(0).max(1),
        })
        .strict(),
      z
        .object({
          operation: z.literal("set_status"),
          id: z.string().min(1).max(200),
          status: z.enum([
            "live",
            "falsified",
            "dominated",
            "selected",
            "deferred",
          ]),
          reopenReason: z.string().min(1).max(4_000).optional(),
          evidence: verifiedEvidence.optional(),
        })
        .strict(),
      z.object({ operation: z.literal("list") }).strict(),
      z
        .object({ operation: z.literal("get"), id: z.string().min(1).max(200) })
        .strict(),
    ]);
    this.pi.registerTool({
      name: "hypothesis_portfolio",
      label: "Hypothesis Portfolio",
      description:
        "Track genuinely competing mechanisms, referenced evidence, predictions, and falsification tests. Do not use for straightforward work.",
      parameters,
      approval: "read",
      loadMode: "discoverable",
      execute: async (_toolCallId, raw) => {
        this.requireReady();
        const input = raw as HypothesisMutationInput | HypothesisReadInput;
        if (input.operation === "list" || input.operation === "get")
          return toolResult(
            readHypotheses(
              this.state.hypotheses,
              input,
            ) as unknown as JsonValue,
          );
        const updated = applyHypothesisMutation(this.state.hypotheses, input, {
          referenceExists: (reference) => this.referenceExists(reference),
        });
        const event = await this.append(
          {
            kind: "hypothesis_changed",
            status: "ok",
            data: {
              operation: updated.operation,
              hypothesis: updated.hypothesis as unknown as JsonObject,
            },
          } as RunEventDraftV1,
          true,
        );
        this.pi.appendEntry(HYPOTHESIS_ENTRY, {
          version: 1,
          kind: "hypothesis_state",
          ledgerEventId: event.eventId,
          operation: updated.operation,
          hypothesis: updated.hypothesis,
        } satisfies HypothesisSessionEntryV1);
        return toolResult({
          operation: updated.operation,
          hypothesis: updated.hypothesis as unknown as JsonObject,
        });
      },
    });
  }

  private registerBeliefTool(): void {
    const z = this.pi.zod;
    const areas = [
      "world_model",
      "goal_model",
      "action_model",
      "recent_finding",
      "open_question",
      "current_plan",
      "cross_task_knowledge",
    ] as const;
    const parameters = z.discriminatedUnion("operation", [
      z
        .object({
          operation: z.literal("upsert_claim"),
          id: z.string().min(1).max(200).optional(),
          area: z.enum(areas),
          claim: z.string().min(1).max(16_000),
          confidence: z.number().finite().min(0).max(1),
          scope: z.string().min(1).max(2_000),
          supportingEvidence: z
            .array(z.string().min(1).max(1_000))
            .max(100)
            .optional(),
          contradictingEvidence: z
            .array(z.string().min(1).max(1_000))
            .max(100)
            .optional(),
        })
        .strict(),
      z
        .object({
          operation: z.literal("add_evidence"),
          id: z.string().min(1).max(200),
          side: z.enum(["supporting", "contradicting"]),
          evidenceRef: z.string().min(1).max(1_000),
        })
        .strict(),
      z
        .object({
          operation: z.literal("set_status"),
          id: z.string().min(1).max(200),
          status: z.enum(["active", "contradicted", "retired"]),
          reason: z.string().min(1).max(4_000),
        })
        .strict(),
      z
        .object({
          operation: z.literal("list"),
          area: z.enum(areas).optional(),
          status: z.enum(["active", "contradicted", "retired"]).optional(),
        })
        .strict(),
      z
        .object({ operation: z.literal("get"), id: z.string().min(1).max(200) })
        .strict(),
    ]);
    this.pi.registerTool({
      name: "belief_state",
      label: "Belief State",
      description:
        "Maintain compact, evidence-linked world, goal, action, finding, question, plan, and cross-task claims when the state ablation is enabled.",
      parameters,
      approval: "read",
      loadMode: "discoverable",
      execute: async (_toolCallId, raw, _signal, _onUpdate, ctx) => {
        this.requireFeature("state", "Belief state");
        const input = raw as BeliefMutationInput | BeliefReadInput;
        if (input.operation === "list" || input.operation === "get")
          return toolResult(
            readBeliefs(this.state.beliefs, input) as unknown as JsonValue,
          );
        const mutation =
          input.operation === "upsert_claim"
            ? {
                ...input,
                freshnessEpoch: this.state.verification.mutationEpoch,
              }
            : input;
        const previous = cloneJson(this.state);
        const claim = applyBeliefMutation(
          this.state.beliefs,
          mutation as BeliefMutationInput,
          {
            referenceExists: (reference) =>
              this.referenceExistsString(reference),
          },
        );
        const event = await this.append(
          {
            kind: "belief_changed",
            status: "ok",
            data: {
              operation: input.operation,
              claim: claim as unknown as JsonObject,
            },
          } as RunEventDraftV1,
          true,
        );
        this.pi.appendEntry(BELIEF_ENTRY, {
          version: 1,
          kind: "belief_state",
          ledgerEventId: event.eventId,
          operation: input.operation,
          claim,
        } satisfies BeliefSessionEntryV1);
        this.scheduleDetectedRefiner(previous, event, ctx);
        return toolResult({
          operation: input.operation,
          claim: claim as unknown as JsonObject,
        });
      },
    });
  }

  private registerComponentTool(): void {
    const z = this.pi.zod;
    const policyPayload = z
      .object({ instructions: z.string().min(1).max(12_000) })
      .strict();
    const skillPayload = z
      .object({
        description: z.string().min(1).max(1_000),
        instructions: z.string().min(1).max(12_000),
      })
      .strict();
    const agentPayload = z
      .object({
        description: z.string().min(1).max(1_000),
        instructions: z.string().min(1).max(12_000),
        tools: z.array(z.enum(["read", "grep", "glob", "web_search"])).max(4),
        modelRole: z.string().startsWith("@").max(100).optional(),
      })
      .strict();
    const memoryPayload = z
      .object({
        claim: z.string().min(1).max(12_000),
        confidence: z.number().finite().min(0).max(1),
        scope: z.string().min(1).max(2_000),
        evidenceRefs: z.array(z.string().min(1).max(1_000)).min(1).max(100),
      })
      .strict();
    const proposal = z.discriminatedUnion("componentKind", [
      z
        .object({
          componentKind: z.literal("policy_overlay"),
          name: z.string().min(2).max(64),
          payload: policyPayload,
          rationale: z.string().min(1).max(4_000),
        })
        .strict(),
      z
        .object({
          componentKind: z.literal("skill"),
          name: z.string().min(2).max(64),
          payload: skillPayload,
          rationale: z.string().min(1).max(4_000),
        })
        .strict(),
      z
        .object({
          componentKind: z.literal("agent"),
          name: z.string().min(2).max(64),
          payload: agentPayload,
          rationale: z.string().min(1).max(4_000),
        })
        .strict(),
      z
        .object({
          componentKind: z.literal("memory"),
          name: z.string().min(2).max(64),
          payload: memoryPayload,
          rationale: z.string().min(1).max(4_000),
        })
        .strict(),
    ]);
    const parameters = z.discriminatedUnion("operation", [
      z.object({ operation: z.literal("propose"), proposal }).strict(),
      z
        .object({
          operation: z.literal("list"),
          status: z
            .enum([
              "proposed",
              "schema_valid",
              "policy_valid",
              "canary_valid",
              "active",
              "rejected",
              "rolled_back",
            ])
            .optional(),
        })
        .strict(),
      z
        .object({
          operation: z.literal("get"),
          revisionId: z.string().min(1).max(200),
        })
        .strict(),
    ]);
    this.pi.registerTool({
      name: "harness_component",
      label: "Harness Component",
      description:
        "Propose or inspect versioned policy, skill, read-only agent, and memory revisions. Activation and rollback remain user-only slash commands.",
      parameters,
      approval: "read",
      loadMode: "discoverable",
      execute: async (_toolCallId, raw) => {
        this.requireFeature("refiner", "Adaptive components");
        const input = raw as
          | {
              operation: "propose";
              proposal: Omit<ComponentProposalInput, "proposedBy">;
            }
          | { operation: "list"; status?: ComponentRevisionV1["status"] }
          | { operation: "get"; revisionId: string };
        if (input.operation === "get")
          return toolResult(
            this.requireRevision(input.revisionId) as unknown as JsonValue,
          );
        if (input.operation === "list") {
          const revisions = [...this.#revisions.values()]
            .filter(
              (revision) =>
                input.status === undefined || revision.status === input.status,
            )
            .sort((left, right) => left.id.localeCompare(right.id));
          return toolResult(revisions as unknown as JsonValue);
        }
        const revision = await this.stageProposal({
          ...input.proposal,
          proposedBy: "model",
        });
        return toolResult(
          revision as unknown as JsonValue,
          revision.status === "rejected",
        );
      },
    });
  }

  private registerExecutableModelTool(): void {
    const z = this.pi.zod;
    const transition = z
      .object({
        from: z.string().min(1).max(100),
        action: z.string().min(1).max(200),
        to: z.string().min(1).max(100),
      })
      .strict();
    const parameters = z.discriminatedUnion("operation", [
      z
        .object({
          operation: z.literal("register"),
          id: z.string().min(1).max(200).optional(),
          label: z.string().min(1).max(500),
          initialState: z.string().min(1).max(100),
          states: z.record(z.string(), z.unknown()),
          transitions: z.array(transition).max(1_024),
          goalStates: z.array(z.string().min(1).max(100)).max(256),
        })
        .strict(),
      z
        .object({
          operation: z.literal("reconstruct"),
          modelId: z.string().min(1).max(200),
          observation: z.unknown(),
        })
        .strict(),
      z
        .object({
          operation: z.literal("simulate"),
          modelId: z.string().min(1).max(200),
          state: z.string().min(1).max(100),
          action: z.string().min(1).max(200),
        })
        .strict(),
      z
        .object({
          operation: z.literal("plan"),
          modelId: z.string().min(1).max(200),
          state: z.string().min(1).max(100),
          goal: z.string().min(1).max(100).optional(),
        })
        .strict(),
      z
        .object({
          operation: z.literal("verify_replay"),
          modelId: z.string().min(1).max(200),
          fromObservation: z.unknown(),
          action: z.string().min(1).max(200),
          actualObservation: z.unknown(),
        })
        .strict(),
      z
        .object({
          operation: z.literal("simplify"),
          modelId: z.string().min(1).max(200),
        })
        .strict(),
      z.object({ operation: z.literal("list") }).strict(),
      z
        .object({
          operation: z.literal("get"),
          modelId: z.string().min(1).max(200),
        })
        .strict(),
    ]);
    this.pi.registerTool({
      name: "executable_model",
      label: "Executable Model",
      description:
        "Register and replay bounded declarative state graphs. No generated code executes in the OMP process.",
      parameters,
      approval: "read",
      loadMode: "discoverable",
      execute: async (_toolCallId, raw) => {
        this.requireFeature("executable_model", "Executable model adapter");
        const input = raw as Record<string, unknown> & {
          operation: string;
          modelId?: string;
        };
        if (input.operation === "list")
          return toolResult([...this.#models.keys()].sort());
        if (input.operation === "get")
          return toolResult(
            this.requireModel(input.modelId).model as unknown as JsonValue,
          );
        if (input.operation === "register") {
          const model = createStateGraphModel(
            input as unknown as Parameters<typeof createStateGraphModel>[0],
          );
          await this.persistModel("register", model);
          return toolResult(model as unknown as JsonValue);
        }
        const model = this.requireModel(input.modelId).model;
        if (input.operation === "reconstruct")
          return toolResult({
            state: reconstructState(model, input.observation as JsonValue),
          });
        if (input.operation === "simulate") {
          const nextState = stepStateGraph(
            model,
            String(input.state),
            String(input.action),
          );
          return toolResult({
            state: nextState,
            observation: renderState(model, nextState),
          });
        }
        if (input.operation === "plan")
          return toolResult({
            actions: planStateGraph(
              model,
              String(input.state),
              typeof input.goal === "string" ? input.goal : undefined,
            ),
          });
        if (input.operation === "verify_replay") {
          const replay = verifyReplay(model, {
            fromObservation: input.fromObservation as JsonValue,
            action: String(input.action),
            actualObservation: input.actualObservation as JsonValue,
          });
          await this.persistReplay(model, replay);
          return toolResult(replay as unknown as JsonValue, !replay.matched);
        }
        if (input.operation === "simplify") {
          const simplified = simplifyStateGraph(
            model,
            this.state.replayRecords,
          );
          await this.persistModel("simplify", simplified);
          return toolResult(simplified as unknown as JsonValue);
        }
        throw new TypeError(
          `Unsupported executable model operation ${input.operation}`,
        );
      },
    });
  }

  private async initialize(ctx: ExtensionContext): Promise<void> {
    if (this.#ledger || this.#initializationError) return;
    try {
      this.#loadedPolicy = await loadProjectPolicy(ctx.cwd);
      const runId = newId("run");
      this.#paths = resolveRunPaths(runId);
      this.#ledger = await RunLedger.create(this.#paths);
      const sessionRef = ctx.sessionManager.getSessionId();
      this.#state = createInitialState(
        runId,
        new Date().toISOString(),
        sessionRef,
      );
      const model = ctx.model
        ? {
            provider: ctx.model.provider,
            id: ctx.model.id,
            ...(this.pi.getThinkingLevel()
              ? { thinkingLevel: this.pi.getThinkingLevel() }
              : {}),
          }
        : undefined;
      await this.append(
        {
          kind: "run_started",
          status: "started",
          sessionRef,
          ...(model ? { model } : {}),
          data: {
            extensionVersion: EXTENSION_VERSION,
            cwdHash: hashJson({ cwd: ctx.cwd }),
            policyHash: this.#loadedPolicy.policyHash,
            systemPromptHash: hashJson(ctx.getSystemPrompt()),
            evaluationCondition: this.#loadedPolicy.policy.evaluation.condition,
            ...(this.#loadedPolicy.policy.evaluation.taskId
              ? { taskId: this.#loadedPolicy.policy.evaluation.taskId }
              : {}),
          },
        } as RunEventDraftV1,
        true,
      );
      if (this.#loadedPolicy.error) {
        await this.append(
          {
            kind: "extension_error",
            status: "error",
            data: { scope: "policy", message: this.#loadedPolicy.error },
          } as RunEventDraftV1,
          true,
        );
      }
      await this.restoreBranchState(ctx);
    } catch (error) {
      this.#initializationError = safeError(error);
      this.pi.logger.error("omp-supercharged initialization failed", {
        error: this.#initializationError,
      });
      if (this.#ledger) await this.#ledger.close().catch(() => undefined);
      this.#ledger = undefined;
    }
  }

  private async append(
    draft: RunEventDraftV1,
    critical = false,
  ): Promise<RunEventV1> {
    if (!this.#ledger || !this.#state)
      throw new Error(
        this.#initializationError ?? "Harness run is not initialized",
      );
    const event = await this.#ledger.append(draft, critical);
    this.#state = reduceEvent(this.#state, event);
    this.#events.push(event);
    this.#eventIds.add(event.eventId);
    if (event.toolCallId) this.#toolCallIds.add(event.toolCallId);
    return event;
  }

  private async handleToolCall(event: ToolCallEvent): Promise<void> {
    if (!this.ready) return;
    let inputHash: string;
    try {
      inputHash = hashJson(event.input);
    } catch (error) {
      this.pi.logger.warn(
        "omp-supercharged could not hash tool input; call remains unclassified",
        { tool: event.toolName, error: safeError(error) },
      );
      return;
    }
    const classification = classifyToolCall(event, this.policy);
    this.#toolCalls.set(event.toolCallId, {
      startedAt: Date.now(),
      inputHash,
      classification,
      observationBefore: cloneJson(this.state.lastObservationRef),
    });
    await this.append({
      kind: "tool_called",
      status: "started",
      toolCallId: event.toolCallId,
      inputHash,
      data: {
        toolName: event.toolName,
        classification: classification.classification,
        classifier: classification.classifier,
        inputHash,
      },
    } as RunEventDraftV1);
  }

  private async handleToolResult(
    event: ToolResultEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (!this.ready) return;
    const metadata = this.#toolCalls.get(event.toolCallId);
    this.#toolCalls.delete(event.toolCallId);
    let inputHash: string;
    let resultHash: string;
    try {
      inputHash = metadata?.inputHash ?? hashJson(event.input);
      resultHash = hashJson(event.content);
    } catch (error) {
      this.pi.logger.warn(
        "omp-supercharged could not hash tool result; result cannot change freshness",
        { tool: event.toolName, error: safeError(error) },
      );
      return;
    }
    const classification =
      metadata?.classification ?? classifyToolCall(event, this.policy);
    const success = !event.isError;
    const previous = cloneJson(this.state);
    const effect: TransitionEffect = !success
      ? "regression"
      : classification.classification === "mutation"
        ? "progress"
        : classification.classification === "verification" &&
            this.state.verification.status === "stale"
          ? "progress"
          : "unknown";
    const transition: TransitionV1 = {
      version: 1,
      kind: "transition",
      id: newId("transition"),
      observationBefore:
        metadata?.observationBefore ?? cloneJson(this.state.lastObservationRef),
      action: {
        version: 1,
        kind: "action",
        tool: event.toolName,
        identityHash: inputHash,
        label: classification.identityLabel,
      },
      observationAfter: observationFromTool(event.toolCallId, resultHash),
      effect,
      budgetDelta: {
        actions: 1,
        elapsedMs: metadata ? Math.max(0, Date.now() - metadata.startedAt) : 0,
      },
      evidenceRefs: [event.toolCallId],
      occurredAt: new Date().toISOString(),
    };
    const data: JsonObject = {
      toolName: event.toolName,
      classification: classification.classification,
      classifier: classification.classifier,
      success,
      inputHash,
      resultHash,
    };
    if (this.hasFeature("state"))
      data.transition = transition as unknown as JsonObject;
    if (classification.classification === "mutation" && success)
      data.mutationEpoch = this.state.verification.mutationEpoch + 1;
    if (
      classification.classification === "verification" &&
      success &&
      this.state.verification.status === "stale"
    ) {
      const evidence: VerificationEvidenceV1 = {
        version: 1,
        kind: "verification_evidence",
        id: newId("evidence"),
        mutationEpoch: this.state.verification.mutationEpoch,
        toolCallId: event.toolCallId,
        classifier: classification.classifier,
        commandIdentityHash: inputHash,
        resultHash,
        observedAt: new Date().toISOString(),
        success: true,
        label: classification.identityLabel,
      };
      data.evidence = evidence as unknown as JsonObject;
    }
    const completed = await this.append(
      {
        kind: "tool_completed",
        status: success ? "ok" : "error",
        toolCallId: event.toolCallId,
        inputHash,
        outputHash: resultHash,
        durationMs: metadata ? Math.max(0, Date.now() - metadata.startedAt) : 0,
        data,
      } as RunEventDraftV1,
      success &&
        (classification.classification === "mutation" ||
          classification.classification === "verification"),
    );
    await this.rollbackRegressingComponents();
    this.scheduleDetectedRefiner(previous, completed, ctx);
  }

  private async handleLineage(
    reason: string,
    details: JsonObject,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (!this.ready) return;
    const loadedPolicy = await loadProjectPolicy(ctx.cwd);
    await this.append(
      {
        kind: "session_lineage",
        status: "ok",
        outputHash: hashJson({
          reason,
          details,
          policyHash: loadedPolicy.policyHash,
        }),
        data: {
          reason,
          ...details,
          invalidatesVerification: true,
          policyHash: loadedPolicy.policyHash,
        },
      } as RunEventDraftV1,
      true,
    );
    this.#revisions.clear();
    this.#models.clear();
    this.#loadedPolicy = loadedPolicy;
    if (loadedPolicy.error)
      await this.append(
        {
          kind: "extension_error",
          status: "error",
          data: { scope: "policy", message: loadedPolicy.error },
        } as RunEventDraftV1,
        true,
      );
    await this.restoreBranchState(ctx);
  }

  private async handleStop(
    turnId: number,
  ): Promise<{
    continue?: boolean;
    additionalContext?: string;
    decision?: "block";
    reason?: string;
  } | void> {
    if (!this.ready || !this.hasFeature("ledger")) return;
    const decision = decideStop(
      this.state,
      this.policy.verification.maxStopContinuations,
    );
    const epoch = this.state.verification.mutationEpoch;
    const reason =
      decision === "permit"
        ? `verification state is ${this.state.verification.status}`
        : decision === "continue"
          ? `mutation epoch ${epoch} has no successful post-mutation verification`
          : decision === "block"
            ? `mutation epoch ${epoch} remains stale after the bounded verification reminder`
            : `local stop ceiling reached with mutation epoch ${epoch} still stale`;
    await this.append(
      {
        kind: "stop_decided",
        status:
          decision === "permit"
            ? "ok"
            : decision === "permit_at_ceiling"
              ? "error"
              : "blocked",
        turnId: String(turnId),
        data: {
          decision,
          mutationEpoch: epoch,
          reason,
          continuation: decision === "continue" || decision === "block",
        },
      } as RunEventDraftV1,
      true,
    );
    if (decision === "continue") {
      return {
        continue: true,
        additionalContext: `Verification freshness gate: mutation epoch ${epoch} is stale. Run a qualifying successful test/check/build after the latest mutation. If verification is unavailable, stop and ask the user to invoke /harness-waive <reason>; the model cannot waive.`,
      };
    }
    if (decision === "block") {
      return {
        decision: "block",
        reason: `Completion remains blocked for stale mutation epoch ${epoch}. Do not claim verification. Obtain fresh successful evidence or ask the user to invoke /harness-waive <reason>. This is the final harness-generated continuation.`,
      };
    }
    if (decision === "permit_at_ceiling") {
      this.pi.logger.warn(
        "omp-supercharged stop ceiling reached while state remains stale",
        { runId: this.state.runId, epoch },
      );
    }
  }

  private async waive(
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    this.requireReady();
    const reason = args.trim();
    if (!reason) throw new Error("Usage: /harness-waive <non-empty reason>");
    if (this.state.verification.status !== "stale")
      throw new Error(
        `Cannot waive while verification state is ${this.state.verification.status}`,
      );
    const waiver: VerificationWaiverV1 = {
      version: 1,
      kind: "verification_waiver",
      id: newId("waiver"),
      mutationEpoch: this.state.verification.mutationEpoch,
      reason,
      observedAt: new Date().toISOString(),
    };
    await this.append(
      {
        kind: "verification_waived",
        status: "waived",
        data: { waiver: waiver as unknown as JsonObject },
      } as RunEventDraftV1,
      true,
    );
    this.notify(
      ctx,
      `Waived verification for mutation epoch ${waiver.mutationEpoch}: ${reason}`,
      "warning",
    );
  }

  private async showStatus(ctx: ExtensionCommandContext): Promise<void> {
    if (!this.ready) {
      this.notify(
        ctx,
        `omp-supercharged unavailable: ${this.#initializationError ?? "session has not started"}`,
        "error",
      );
      return;
    }
    const counts = hypothesisCounts(this.state);
    const elapsed = Math.max(0, Date.now() - Date.parse(this.state.startedAt));
    const latest = this.state.verification.latestMutation;
    const covering =
      this.state.verification.coveringEvidence?.id ??
      this.state.verification.coveringWaiver?.id ??
      "none";
    const policyErrors = this.state.policyErrors.length
      ? this.state.policyErrors.join(" | ")
      : "none";
    const rows = [
      `run: ${this.state.runId}`,
      `ledger: ${this.paths.ledgerPath}`,
      `storage: ${this.ledger.healthy ? "healthy" : `unhealthy (${this.ledger.failure ?? "unknown"})`}`,
      `verification: ${this.state.verification.status} (epoch ${this.state.verification.mutationEpoch})`,
      `latest mutation: ${latest ? `${latest.toolName} / ${latest.eventId}` : "none"}`,
      `covering evidence/waiver: ${covering}`,
      `hypotheses: live=${counts.live}, selected=${counts.selected}, falsified=${counts.falsified}, dominated=${counts.dominated}, deferred=${counts.deferred}`,
      `components: ${this.#revisions.size} revisions, ${this.activeRevisions().length} active`,
      `events: ${this.ledger.eventCount}`,
      `elapsedMs: ${elapsed}`,
      `stop ceiling: ${this.policy.verification.maxStopContinuations} reminder(s) plus one final block continuation`,
      `evaluation condition: ${this.policy.evaluation.condition}`,
      `policy errors: ${policyErrors}`,
    ];
    this.notify(ctx, rows.join("\n"));
  }

  private async exportManifest(ctx?: ExtensionCommandContext): Promise<void> {
    this.requireReady();
    await this.ledger.flush();
    const events = await this.ledger.readCanonical();
    const manifest = deriveManifest(
      events,
      await this.ledger.hash(),
      this.policy,
      { extensionVersion: EXTENSION_VERSION },
    );
    await writePrivateAtomic(
      this.paths.manifestPath,
      manifest as unknown as JsonObject,
    );
    const manifestHash = hashJson(manifest);
    if (ctx)
      this.notify(
        ctx,
        `Manifest exported to ${this.paths.manifestPath}\nmanifest hash: ${manifestHash}`,
      );
  }

  private async shutdown(ctx: ExtensionContext): Promise<void> {
    if (this.#closed || this.#closing) return;
    this.#closing = true;
    if (this.#pendingRefiner) {
      ctx.clearTimer(this.#pendingRefiner);
      this.#pendingRefiner = undefined;
    }
    if (!this.#ledger || !this.#paths || !this.#loadedPolicy || !this.#state) {
      this.#closed = true;
      this.#closing = false;
      return;
    }
    try {
      await this.append(
        {
          kind: "run_finished",
          status: "ok",
          data: { reason: this.state.stopReason ?? "session_shutdown" },
        } as RunEventDraftV1,
        true,
      );
      await this.exportManifest();
    } catch (error) {
      this.pi.logger.error("omp-supercharged shutdown persistence failed", {
        error: safeError(error),
      });
    } finally {
      await this.ledger
        .close()
        .catch((error) =>
          this.pi.logger.error("omp-supercharged ledger close failed", {
            error: safeError(error),
          }),
        );
      this.#closed = true;
      this.#closing = false;
    }
  }

  private async restoreBranchState(ctx: ExtensionContext): Promise<void> {
    const hypotheses = new Map<string, HypothesisSessionEntryV1>();
    const beliefs = new Map<string, BeliefSessionEntryV1>();
    const componentEntries = new Map<string, ComponentRevisionEntryV1>();
    const activeComponents = new Map<string, string>();
    const modelEntries = new Map<string, ModelSessionEntryV1>();
    const replays: ReplayRecordV1[] = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      const data = entry.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      const record = data as Record<string, unknown>;
      if (
        entry.customType === HYPOTHESIS_ENTRY &&
        record.version === 1 &&
        record.kind === "hypothesis_state"
      ) {
        const item = record as unknown as HypothesisSessionEntryV1;
        if (item.hypothesis?.id) hypotheses.set(item.hypothesis.id, item);
      } else if (
        entry.customType === BELIEF_ENTRY &&
        record.version === 1 &&
        record.kind === "belief_state"
      ) {
        const item = record as unknown as BeliefSessionEntryV1;
        if (item.claim?.id) beliefs.set(item.claim.id, item);
      } else if (
        entry.customType === COMPONENT_ENTRY &&
        record.version === 1 &&
        record.kind === "component_revision_ref"
      ) {
        const item = record as unknown as ComponentRevisionEntryV1;
        if (!item.revisionId) continue;
        componentEntries.set(item.revisionId, item);
        const key = componentKey(item.componentKind, item.name);
        if (item.status === "active")
          activeComponents.set(key, item.revisionId);
        if (
          item.status === "rolled_back" &&
          activeComponents.get(key) === item.revisionId
        ) {
          activeComponents.delete(key);
          if (item.parentRevisionId)
            activeComponents.set(key, item.parentRevisionId);
        }
      } else if (
        entry.customType === MODEL_ENTRY &&
        record.version === 1 &&
        record.kind === "state_graph_model_ref"
      ) {
        const item = record as unknown as ModelSessionEntryV1;
        if (item.operation === "replay" && item.replay)
          replays.push(item.replay);
        else if (item.modelId) modelEntries.set(item.modelId, item);
      }
    }
    for (const item of hypotheses.values()) {
      await this.append({
        kind: "hypothesis_changed",
        status: "ok",
        parentEventId: item.ledgerEventId,
        data: {
          operation: "reconstructed",
          hypothesis: item.hypothesis as unknown as JsonObject,
        },
      } as RunEventDraftV1);
    }
    for (const item of beliefs.values()) {
      await this.append({
        kind: "belief_changed",
        status: "ok",
        parentEventId: item.ledgerEventId,
        data: {
          operation: "reconstructed",
          claim: item.claim as unknown as JsonObject,
        },
      } as RunEventDraftV1);
    }
    for (const item of componentEntries.values()) {
      try {
        const revision = await restoreComponentRevision(
          this.paths.componentsRoot,
          item,
        );
        this.#revisions.set(revision.id, revision);
        const data = revisionAsLedgerData(revision);
        data.reconstructed = true;
        await this.append({
          kind: "component_changed",
          status: revision.status === "rejected" ? "error" : "ok",
          parentEventId: item.revisionId,
          data,
        } as RunEventDraftV1);
        this.state.components[revision.id] = revision;
      } catch (error) {
        await this.append({
          kind: "extension_error",
          status: "error",
          data: { scope: "component_restore", message: safeError(error) },
        } as RunEventDraftV1);
      }
    }
    this.state.activeComponents = Object.fromEntries(activeComponents);
    for (const item of modelEntries.values()) {
      try {
        const model = await restoreStateGraphModel(
          this.paths.modelsRoot,
          item.contentHash,
        );
        this.#models.set(model.id, model);
        await this.append({
          kind: "executable_model_changed",
          status: "ok",
          parentEventId: item.ledgerEventId,
          data: {
            operation: "reconstructed",
            modelId: model.id,
            contentHash: item.contentHash,
          },
        } as RunEventDraftV1);
        this.state.executableModels[model.id] = model;
      } catch (error) {
        await this.append({
          kind: "extension_error",
          status: "error",
          data: { scope: "model_restore", message: safeError(error) },
        } as RunEventDraftV1);
      }
    }
    this.state.replayRecords = replays;
  }

  private async stageProposal(
    input: ComponentProposalInput,
  ): Promise<ComponentRevisionV1> {
    const key = componentKey(input.componentKind, input.name);
    const revision = createComponentProposal(input, {
      parentRevisionId: this.state.activeComponents[key],
      metrics: this.metricSnapshot(),
    });
    if (revision.componentKind === "memory") {
      const payload = revision.payload;
      if (!("evidenceRefs" in payload) || !Array.isArray(payload.evidenceRefs))
        throw new TypeError("Memory component requires evidence references");
      for (const reference of payload.evidenceRefs) {
        if (
          typeof reference !== "string" ||
          !this.referenceExistsString(reference)
        ) {
          throw new TypeError(
            `Memory component references unknown evidence ${String(reference)}`,
          );
        }
      }
    }
    await this.persistComponentLifecycle(revision);
    let latest = revision;
    for (const transition of validateComponentRevision(
      revision,
      this.activeRevisions(),
    )) {
      latest = transition;
      await this.persistComponentLifecycle(transition);
    }
    return latest;
  }

  private async persistComponentLifecycle(
    revision: ComponentRevisionV1,
    reconstructed = false,
  ): Promise<RunEventV1> {
    await persistComponentPayload(this.paths.componentsRoot, revision);
    const data = revisionAsLedgerData(revision);
    if (reconstructed) data.reconstructed = true;
    const event = await this.append(
      {
        kind: "component_changed",
        status:
          revision.status === "rejected"
            ? "error"
            : revision.status === "rolled_back"
              ? "blocked"
              : "ok",
        data,
      } as RunEventDraftV1,
      true,
    );
    this.#revisions.set(revision.id, revision);
    this.state.components[revision.id] = revision;
    this.pi.appendEntry(COMPONENT_ENTRY, componentRevisionEntry(revision));
    return event;
  }

  private async persistModel(
    operation: "register" | "simplify",
    model: StateGraphModelV1,
  ): Promise<void> {
    const contentHash = await persistStateGraphModel(
      this.paths.modelsRoot,
      model,
    );
    const event = await this.append(
      {
        kind: "executable_model_changed",
        status: "ok",
        data: { operation, modelId: model.id, contentHash },
      } as RunEventDraftV1,
      true,
    );
    this.#models.set(model.id, model);
    this.state.executableModels[model.id] = model;
    this.pi.appendEntry(MODEL_ENTRY, {
      version: 1,
      kind: "state_graph_model_ref",
      ledgerEventId: event.eventId,
      operation,
      modelId: model.id,
      contentHash,
    } satisfies ModelSessionEntryV1);
  }

  private async persistReplay(
    model: StateGraphModelV1,
    replay: ReplayRecordV1,
  ): Promise<void> {
    const contentHash = hashJson(model);
    const event = await this.append(
      {
        kind: "executable_model_changed",
        status: replay.matched ? "ok" : "error",
        data: {
          operation: "replay",
          modelId: model.id,
          contentHash,
          replay: replay as unknown as JsonObject,
        },
      } as RunEventDraftV1,
      true,
    );
    this.state.replayRecords.push(replay);
    this.pi.appendEntry(MODEL_ENTRY, {
      version: 1,
      kind: "state_graph_model_ref",
      ledgerEventId: event.eventId,
      operation: "replay",
      modelId: model.id,
      contentHash,
      replay,
    } satisfies ModelSessionEntryV1);
  }

  private scheduleDetectedRefiner(
    previous: HarnessStateV1,
    latestEvent: RunEventV1,
    ctx?: ExtensionContext,
  ): void {
    if (!this.ready || !this.hasFeature("refiner")) return;
    const triggers = detectRefinerTriggers(
      previous,
      this.state,
      latestEvent,
      this.policy.refiner,
    );
    if (
      triggers.length === 0 ||
      this.#pendingRefiner ||
      this.#refinerInFlight ||
      !ctx
    )
      return;
    const trigger = triggers[0];
    this.#pendingRefiner = ctx.setTimeout(async () => {
      this.#pendingRefiner = undefined;
      await this.runRefinement(trigger, ctx, latestEvent.eventId).catch(
        (error) =>
          this.pi.logger.warn("omp-supercharged automatic refiner failed", {
            error: safeError(error),
          }),
      );
    }, 0);
  }

  private async runRefinement(
    trigger: RefinerTrigger | "manual",
    ctx: ExtensionContext,
    triggerEventId?: string,
    manualReason?: string,
  ): Promise<void> {
    this.requireReady();
    if (this.#refinerInFlight)
      throw new Error("A Refiner pass is already running");
    if (this.state.refinerRuns >= this.policy.refiner.maxRuns)
      throw new Error(
        `Refiner run ceiling ${this.policy.refiner.maxRuns} reached`,
      );
    const model =
      ctx.models.resolve(this.policy.refiner.model) ??
      ctx.models.resolve("@smol") ??
      ctx.model;
    if (!model)
      throw new Error(
        `No authenticated model resolves for ${this.policy.refiner.model}`,
      );
    const snapshot = buildRefinerSnapshot(
      this.state,
      this.#events,
      this.activeRevisions(),
      trigger,
      this.policy.refiner.maxInputTokens,
    );
    if (manualReason)
      snapshot.metrics.manualReasonHash = hashJson({ reason: manualReason });
    const snapshotHash = hashJson(snapshot);
    const runNumber = this.state.refinerRuns + 1;
    await this.append(
      {
        kind: "refiner_started",
        status: "started",
        ...(triggerEventId ? { parentEventId: triggerEventId } : {}),
        data: {
          trigger,
          runNumber,
          snapshotHash,
          model: `${model.provider}/${model.id}`,
        },
      } as RunEventDraftV1,
      true,
    );
    this.#refinerInFlight = true;
    let proposalCount = 0;
    let activatedCount = 0;
    try {
      const runner = this.createOmpRefinerRunner(ctx, model);
      const result = await runRefiner(runner, snapshot, this.policy.refiner);
      proposalCount = result.proposals.length;
      for (const proposal of result.proposals) {
        const staged = await this.stageProposal({
          ...proposal,
          proposedBy: "refiner",
          ...(triggerEventId ? { triggerEventId } : {}),
        });
        if (
          this.policy.refiner.autoActivate &&
          staged.status === "canary_valid"
        ) {
          await this.persistComponentLifecycle(
            activateComponentRevision(staged, this.metricSnapshot()),
          );
          activatedCount++;
        }
      }
      await this.append(
        {
          kind: "refiner_finished",
          status: "ok",
          ...(triggerEventId ? { parentEventId: triggerEventId } : {}),
          data: { trigger, runNumber, proposalCount, activatedCount },
        } as RunEventDraftV1,
        true,
      );
    } catch (error) {
      await this.append(
        {
          kind: "refiner_finished",
          status: "error",
          ...(triggerEventId ? { parentEventId: triggerEventId } : {}),
          data: {
            trigger,
            runNumber,
            proposalCount,
            activatedCount,
            error: safeError(error),
          },
        } as RunEventDraftV1,
        true,
      );
      throw error;
    } finally {
      this.#refinerInFlight = false;
    }
  }

  private createOmpRefinerRunner(
    ctx: ExtensionContext,
    model: NonNullable<ExtensionContext["model"]>,
  ): RefinerModelRunner {
    return {
      modelLabel: `${model.provider}/${model.id}`,
      run: async (systemPrompt, userPrompt, limits) => {
        const boundedModel = {
          ...model,
          maxTokens: Math.min(model.maxTokens, limits.maxOutputTokens),
        };
        const sessionManager = this.pi.pi.SessionManager.inMemory(ctx.cwd);
        const result = await this.pi.pi.createAgentSession({
          cwd: ctx.cwd,
          model: boundedModel,
          modelRegistry: ctx.modelRegistry,
          thinkingLevel: this.policy.refiner.thinkingLevel,
          systemPrompt,
          deadline: Date.now() + limits.maxRuntimeMs,
          disableExtensionDiscovery: true,
          enableMCP: false,
          enableLsp: false,
          enableIrc: false,
          skipPythonPreflight: true,
          toolNames: [],
          restrictToolNames: true,
          requireYieldTool: false,
          customTools: [],
          extensions: [],
          skills: [],
          rules: [],
          contextFiles: [],
          promptTemplates: [],
          slashCommands: [],
          sessionManager,
          hasUI: false,
          autoApprove: false,
        });
        try {
          await result.session.prompt(userPrompt, {
            expandPromptTemplates: false,
          });
          return assistantText(result.session.messages);
        } finally {
          await result.session.dispose();
        }
      },
    };
  }

  private async rollbackRegressingComponents(): Promise<void> {
    const metrics = this.metricSnapshot();
    for (const revision of this.activeRevisions()) {
      if (!shouldRollbackComponent(revision, metrics)) continue;
      const rolledBack = rollbackComponentRevision(
        revision,
        "Automatic rollback: post-activation verification or regression threshold exceeded",
        metrics,
      );
      await this.persistComponentLifecycle(rolledBack);
    }
  }

  private activeRevisions(): ComponentRevisionV1[] {
    const revisions: ComponentRevisionV1[] = [];
    for (const revisionId of Object.values(
      this.#state?.activeComponents ?? {},
    )) {
      const revision = this.#revisions.get(revisionId);
      if (revision) revisions.push(revision);
    }
    return revisions;
  }

  private metricSnapshot(): ComponentMetricSnapshotV1 {
    return {
      actions: this.state.metrics.actions,
      verificationFailures: this.state.metrics.verificationFailures,
      regressions: this.state.metrics.regressions,
      successfulVerifications: this.state.metrics.successfulVerifications,
    };
  }

  private referenceExists(reference: EvidenceRefV1): boolean {
    if (reference.kind === "run_event")
      return this.#eventIds.has(reference.ref);
    if (reference.kind === "tool_call")
      return this.#toolCallIds.has(reference.ref);
    if (reference.kind === "artifact")
      return (
        reference.ref.startsWith("artifact://") ||
        this.state.artifactRefs.includes(reference.ref)
      );
    return true;
  }

  private referenceExistsString(reference: string): boolean {
    return (
      this.#eventIds.has(reference) ||
      this.#toolCallIds.has(reference) ||
      reference.startsWith("artifact://")
    );
  }

  private requireRevision(revisionId: string): ComponentRevisionV1 {
    const revision = this.#revisions.get(revisionId);
    if (!revision) throw new Error(`Unknown component revision ${revisionId}`);
    return revision;
  }

  private requireModel(modelId: unknown): { model: StateGraphModelV1 } {
    if (typeof modelId !== "string" || modelId.length === 0)
      throw new TypeError("modelId is required");
    const model = this.#models.get(modelId);
    if (!model) throw new Error(`Unknown executable model ${modelId}`);
    return { model };
  }

  private hasFeature(
    minimum: ProjectPolicyV1["evaluation"]["condition"],
  ): boolean {
    return (
      this.#loadedPolicy !== undefined &&
      FEATURE_ORDER[this.#loadedPolicy.policy.evaluation.condition] >=
        FEATURE_ORDER[minimum]
    );
  }

  private requireFeature(
    minimum: ProjectPolicyV1["evaluation"]["condition"],
    label: string,
  ): void {
    this.requireReady();
    if (!this.hasFeature(minimum))
      throw new Error(
        `${label} requires evaluation.condition=${minimum} or higher; current condition is ${this.policy.evaluation.condition}`,
      );
  }

  private notify(
    ctx: ExtensionCommandContext,
    message: string,
    level: "info" | "warning" | "error" = "info",
  ): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else if (level === "error") this.pi.logger.error(message);
    else if (level === "warning") this.pi.logger.warn(message);
    else this.pi.logger.info(message);
  }

  private requireReady(): void {
    if (!this.ready)
      throw new Error(
        this.#initializationError ?? "Harness session has not started",
      );
  }

  private get ready(): boolean {
    return Boolean(
      this.#ledger &&
        this.#paths &&
        this.#loadedPolicy &&
        this.#state &&
        !this.#closed,
    );
  }

  private get ledger(): RunLedger {
    if (!this.#ledger) throw new Error("Ledger is unavailable");
    return this.#ledger;
  }

  private get paths(): RunPaths {
    if (!this.#paths) throw new Error("Harness paths are unavailable");
    return this.#paths;
  }

  private get state(): HarnessStateV1 {
    if (!this.#state) throw new Error("Harness state is unavailable");
    return this.#state;
  }

  private get policy(): ProjectPolicyV1 {
    if (!this.#loadedPolicy) throw new Error("Harness policy is unavailable");
    return this.#loadedPolicy.policy;
  }
}

export function registerHarness(pi: ExtensionAPI): HarnessRuntime {
  const runtime = new HarnessRuntime(pi);
  runtime.register();
  return runtime;
}
