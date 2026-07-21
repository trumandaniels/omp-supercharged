import {
  assertFiniteUnitInterval,
  assertNonEmptyString,
  cloneJson,
  newId,
} from "./canonical.ts";
import type {
  BeliefArea,
  BeliefClaimV1,
  BeliefStateV1,
  BeliefStatus,
} from "./types.ts";

export type BeliefMutationInput =
  | {
      operation: "upsert_claim";
      id?: string;
      area: BeliefArea;
      claim: string;
      confidence: number;
      scope: string;
      freshnessEpoch: number;
      supportingEvidence?: string[];
      contradictingEvidence?: string[];
    }
  | {
      operation: "add_evidence";
      id: string;
      side: "supporting" | "contradicting";
      evidenceRef: string;
    }
  | {
      operation: "set_status";
      id: string;
      status: BeliefStatus;
      reason: string;
    };

export type BeliefReadInput =
  | { operation: "list"; area?: BeliefArea; status?: BeliefStatus }
  | { operation: "get"; id: string };

const AREAS: Record<BeliefArea, true> = {
  world_model: true,
  goal_model: true,
  action_model: true,
  recent_finding: true,
  open_question: true,
  current_plan: true,
  cross_task_knowledge: true,
};

const STATUSES: Record<BeliefStatus, true> = {
  active: true,
  contradicted: true,
  retired: true,
};

function validateEvidenceRefs(
  values: unknown,
  field: string,
  referenceExists: (reference: string) => boolean,
): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new TypeError(`${field} must be an array`);
  const seen = new Set<string>();
  return values.map((value, index) => {
    assertNonEmptyString(value, `${field}[${index}]`, 1_000);
    if (!referenceExists(value))
      throw new TypeError(
        `${field}[${index}] does not reference known evidence`,
      );
    if (seen.has(value))
      throw new TypeError(`${field} contains duplicate ${value}`);
    seen.add(value);
    return value;
  });
}

function requireClaim(
  state: Readonly<BeliefStateV1>,
  id: string,
): BeliefClaimV1 {
  assertNonEmptyString(id, "claim.id", 200);
  if (!Object.hasOwn(state.claims, id))
    throw new TypeError(`Unknown belief claim ${id}`);
  return cloneJson(state.claims[id]);
}

export function applyBeliefMutation(
  state: Readonly<BeliefStateV1>,
  input: BeliefMutationInput,
  options: {
    now?: string;
    idFactory?: (prefix: string) => string;
    referenceExists?: (reference: string) => boolean;
  } = {},
): BeliefClaimV1 {
  const current = state;
  const now = options.now ?? new Date().toISOString();
  const referenceExists = options.referenceExists ?? (() => false);
  if (input.operation === "upsert_claim") {
    if (!Object.hasOwn(AREAS, input.area))
      throw new TypeError("Invalid belief area");
    assertNonEmptyString(input.claim, "claim.claim", 16_000);
    assertFiniteUnitInterval(input.confidence, "claim.confidence");
    assertNonEmptyString(input.scope, "claim.scope", 2_000);
    if (!Number.isSafeInteger(input.freshnessEpoch) || input.freshnessEpoch < 0)
      throw new TypeError(
        "claim.freshnessEpoch must be a non-negative integer",
      );
    const id = input.id?.trim() || (options.idFactory ?? newId)("belief");
    const previous = Object.hasOwn(current.claims, id)
      ? current.claims[id]
      : undefined;
    return {
      version: 1,
      kind: "belief_claim",
      id,
      area: input.area,
      claim: input.claim.trim(),
      confidence: input.confidence,
      scope: input.scope.trim(),
      supportingEvidence: validateEvidenceRefs(
        input.supportingEvidence,
        "supportingEvidence",
        referenceExists,
      ),
      contradictingEvidence: validateEvidenceRefs(
        input.contradictingEvidence,
        "contradictingEvidence",
        referenceExists,
      ),
      freshnessEpoch: input.freshnessEpoch,
      status: previous?.status ?? "active",
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
  }
  const claim = requireClaim(current, input.id);
  if (input.operation === "add_evidence") {
    assertNonEmptyString(input.evidenceRef, "evidenceRef", 1_000);
    if (!referenceExists(input.evidenceRef))
      throw new TypeError("Evidence reference does not exist");
    const target =
      input.side === "supporting"
        ? claim.supportingEvidence
        : input.side === "contradicting"
          ? claim.contradictingEvidence
          : undefined;
    if (!target)
      throw new TypeError("Evidence side must be supporting or contradicting");
    if (target.includes(input.evidenceRef))
      throw new TypeError("Duplicate evidence reference");
    target.push(input.evidenceRef);
    if (input.side === "contradicting") claim.status = "contradicted";
  } else {
    if (!Object.hasOwn(STATUSES, input.status))
      throw new TypeError("Invalid belief status");
    assertNonEmptyString(input.reason, "status reason", 4_000);
    if (
      input.status === "active" &&
      claim.status === "contradicted" &&
      claim.supportingEvidence.length === 0
    ) {
      throw new TypeError(
        "A contradicted claim requires supporting evidence before reactivation",
      );
    }
    claim.status = input.status;
  }
  claim.updatedAt = now;
  return claim;
}

export function readBeliefs(
  state: Readonly<BeliefStateV1>,
  input: BeliefReadInput,
): BeliefClaimV1[] | BeliefClaimV1 {
  if (input.operation === "get") return requireClaim(state, input.id);
  if (input.area !== undefined && !Object.hasOwn(AREAS, input.area))
    throw new TypeError("Invalid belief area");
  if (input.status !== undefined && !Object.hasOwn(STATUSES, input.status))
    throw new TypeError("Invalid belief status");
  return Object.values(state.claims)
    .filter((claim) => input.area === undefined || claim.area === input.area)
    .filter(
      (claim) => input.status === undefined || claim.status === input.status,
    )
    .map((claim) => cloneJson(claim))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function renderBeliefState(state: Readonly<BeliefStateV1>): string {
  const sections: string[] = [];
  for (const area of Object.keys(AREAS) as BeliefArea[]) {
    const claims = Object.values(state.claims).filter(
      (claim) => claim.area === area && claim.status === "active",
    );
    if (claims.length === 0) continue;
    sections.push(`## ${area}`);
    for (const claim of claims.sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      sections.push(
        `- [${claim.id}] (${claim.confidence.toFixed(2)}, epoch ${claim.freshnessEpoch}) ${claim.claim}`,
      );
    }
  }
  return sections.join("\n");
}
