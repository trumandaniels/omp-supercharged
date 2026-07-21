import {
  assertFiniteUnitInterval,
  assertNonEmptyString,
  cloneJson,
  newId,
} from "./canonical.ts";
import type {
  EvidenceRefV1,
  FalsificationTestV1,
  HypothesisStatus,
  HypothesisV1,
  PredictionV1,
} from "./types.ts";

export type HypothesisMutationInput =
  | {
      operation: "create";
      id?: string;
      mechanism: string;
      confidence: number;
      status?: "live" | "deferred";
    }
  | {
      operation: "add_evidence";
      id: string;
      side: "for" | "against";
      evidence: EvidenceRefV1;
    }
  | { operation: "add_prediction"; id: string; prediction: PredictionV1 }
  | {
      operation: "set_falsification_test";
      id: string;
      test: FalsificationTestV1;
    }
  | { operation: "set_confidence"; id: string; confidence: number }
  | {
      operation: "set_status";
      id: string;
      status: HypothesisStatus;
      reopenReason?: string;
      evidence?: EvidenceRefV1;
    };

export type HypothesisReadInput =
  | { operation: "list" }
  | { operation: "get"; id: string };

export interface HypothesisMutationResult {
  hypothesis: HypothesisV1;
  operation: HypothesisMutationInput["operation"];
}

function validateEvidenceReference(
  evidence: EvidenceRefV1,
  referenceExists: (reference: EvidenceRefV1) => boolean,
): void {
  if (!evidence || typeof evidence !== "object")
    throw new TypeError("Evidence reference must be an object");
  const allowedKinds: Record<string, true> = {
    run_event: true,
    tool_call: true,
    artifact: true,
    unverified_note: true,
  };
  if (!allowedKinds[evidence.kind])
    throw new TypeError("Evidence reference kind is invalid");
  assertNonEmptyString(evidence.ref, "evidence.ref", 1_000);
  if (evidence.kind === "unverified_note") {
    assertNonEmptyString(evidence.note, "unverified evidence note", 2_000);
    return;
  }
  if (!referenceExists(evidence))
    throw new TypeError(`Evidence reference does not exist: ${evidence.ref}`);
}

function validatePrediction(prediction: PredictionV1): void {
  if (!prediction || typeof prediction !== "object")
    throw new TypeError("Prediction must be an object");
  assertNonEmptyString(prediction.id, "prediction.id", 200);
  assertNonEmptyString(prediction.description, "prediction.description", 4_000);
  assertNonEmptyString(prediction.observable, "prediction.observable", 4_000);
}

function validateFalsificationTest(test: FalsificationTestV1): void {
  if (!test || typeof test !== "object")
    throw new TypeError("Falsification test must be an object");
  assertNonEmptyString(
    test.description,
    "falsification test description",
    8_000,
  );
  if (
    test.risk !== undefined &&
    !["read-only", "reversible", "irreversible"].includes(test.risk)
  )
    throw new TypeError("Invalid falsification test risk");
  if (test.estimatedCost !== undefined) {
    if (
      !test.estimatedCost ||
      typeof test.estimatedCost !== "object" ||
      Array.isArray(test.estimatedCost)
    )
      throw new TypeError("estimatedCost must be an object");
    for (const [key, value] of Object.entries(test.estimatedCost)) {
      assertNonEmptyString(key, "estimatedCost key", 100);
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        throw new TypeError(
          `estimatedCost.${key} must be non-negative and finite`,
        );
    }
  }
}

function requireHypothesis(
  portfolio: Record<string, HypothesisV1>,
  id: string,
): HypothesisV1 {
  assertNonEmptyString(id, "hypothesis.id", 200);
  const hypothesis = portfolio[id];
  if (!hypothesis) throw new TypeError(`Unknown hypothesis ${id}`);
  return cloneJson(hypothesis);
}

export function applyHypothesisMutation(
  portfolio: Readonly<Record<string, HypothesisV1>>,
  input: HypothesisMutationInput,
  options: {
    now?: string;
    idFactory?: (prefix: string) => string;
    referenceExists?: (reference: EvidenceRefV1) => boolean;
  } = {},
): HypothesisMutationResult {
  const mutable = portfolio as Record<string, HypothesisV1>;
  const now = options.now ?? new Date().toISOString();
  const idFactory = options.idFactory ?? newId;
  const referenceExists = options.referenceExists ?? (() => false);
  if (input.operation === "create") {
    assertNonEmptyString(input.mechanism, "hypothesis.mechanism", 16_000);
    assertFiniteUnitInterval(input.confidence, "hypothesis.confidence");
    const id = input.id?.trim() || idFactory("hypothesis");
    assertNonEmptyString(id, "hypothesis.id", 200);
    if (mutable[id]) throw new TypeError(`Hypothesis ${id} already exists`);
    const hypothesis: HypothesisV1 = {
      version: 1,
      kind: "hypothesis",
      id,
      mechanism: input.mechanism.trim(),
      evidenceFor: [],
      evidenceAgainst: [],
      predictions: [],
      confidence: input.confidence,
      status: input.status ?? "live",
      createdAt: now,
      updatedAt: now,
    };
    return { operation: input.operation, hypothesis };
  }
  const hypothesis = requireHypothesis(mutable, input.id);
  if (input.operation === "add_evidence") {
    validateEvidenceReference(input.evidence, referenceExists);
    const target =
      input.side === "for"
        ? hypothesis.evidenceFor
        : input.side === "against"
          ? hypothesis.evidenceAgainst
          : undefined;
    if (!target) throw new TypeError("Evidence side must be for or against");
    if (
      target.some(
        (existing) =>
          existing.kind === input.evidence.kind &&
          existing.ref === input.evidence.ref,
      )
    )
      throw new TypeError("Duplicate evidence reference");
    target.push(cloneJson(input.evidence));
  } else if (input.operation === "add_prediction") {
    validatePrediction(input.prediction);
    if (
      hypothesis.predictions.some(
        (prediction) => prediction.id === input.prediction.id,
      )
    )
      throw new TypeError(`Prediction ${input.prediction.id} already exists`);
    hypothesis.predictions.push(cloneJson(input.prediction));
  } else if (input.operation === "set_falsification_test") {
    validateFalsificationTest(input.test);
    hypothesis.falsificationTest = cloneJson(input.test);
  } else if (input.operation === "set_confidence") {
    assertFiniteUnitInterval(input.confidence, "hypothesis.confidence");
    hypothesis.confidence = input.confidence;
  } else if (input.operation === "set_status") {
    const statuses: Record<HypothesisStatus, true> = {
      live: true,
      falsified: true,
      dominated: true,
      selected: true,
      deferred: true,
    };
    if (!statuses[input.status])
      throw new TypeError("Invalid hypothesis status");
    if (hypothesis.status === "falsified") {
      if (input.status === "selected")
        throw new TypeError(
          "A falsified hypothesis must be reopened in a separate event before selection",
        );
      if (input.status !== "falsified") {
        assertNonEmptyString(input.reopenReason, "reopenReason", 4_000);
        if (!input.evidence)
          throw new TypeError(
            "Reopening a falsified hypothesis requires new evidence",
          );
        validateEvidenceReference(input.evidence, referenceExists);
        if (input.evidence.kind === "unverified_note")
          throw new TypeError(
            "Reopening requires verified evidence, not an unverified note",
          );
        hypothesis.evidenceFor.push(cloneJson(input.evidence));
      }
    }
    hypothesis.status = input.status;
  }
  hypothesis.updatedAt = now;
  return { operation: input.operation, hypothesis };
}

export function readHypotheses(
  portfolio: Readonly<Record<string, HypothesisV1>>,
  input: HypothesisReadInput,
): HypothesisV1[] | HypothesisV1 {
  if (input.operation === "get")
    return requireHypothesis(
      portfolio as Record<string, HypothesisV1>,
      input.id,
    );
  return Object.values(portfolio)
    .map((hypothesis) => cloneJson(hypothesis))
    .sort((left, right) => left.id.localeCompare(right.id));
}
