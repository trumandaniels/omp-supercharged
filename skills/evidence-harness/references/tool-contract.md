# Hypothesis portfolio tool contract

Source snapshot: `omp-supercharged` 0.1.0, 2026-07-20.

Use this reference when constructing `hypothesis_portfolio` calls or recovering from a rejected transition. The tool schema remains authoritative if it differs from this guide.

## Operations

| Operation                | Purpose                                     | Required fields                                                     |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------- |
| `create`                 | Add a new live or deferred mechanism        | `mechanism`, `confidence`; optional `id`, `status`                  |
| `add_evidence`           | Link evidence for or against one hypothesis | `id`, `side`, `evidence`                                            |
| `add_prediction`         | Record a differentiating observable         | `id`, `prediction`                                                  |
| `set_falsification_test` | Record the next discriminating test         | `id`, `test`                                                        |
| `set_confidence`         | Update calibrated confidence                | `id`, `confidence`                                                  |
| `set_status`             | Move among lifecycle states                 | `id`, `status`; reopening may require `reopenReason` and `evidence` |
| `list`                   | Read the sorted portfolio                   | none                                                                |
| `get`                    | Read one hypothesis                         | `id`                                                                |

One mutation operation changes one hypothesis atomically. Use `list` or `get` to refresh state after a rejection rather than guessing current values.

## Evidence references

```text
EvidenceRef {
  kind: run_event | tool_call | artifact | unverified_note
  ref: non-empty existing reference
  note?: required explanatory text for unverified_note
}
```

A `run_event`, `tool_call`, or `artifact` reference must already exist in the current run's registered state. An `artifact://` prefix alone does not establish existence. Use `unverified_note` only to preserve unsupported context; it is not verified evidence.

Duplicate evidence with the same `kind` and `ref` on the same side is rejected.

## Predictions and tests

```text
Prediction {
  id: non-empty stable ID
  description: expected relationship
  observable: externally checkable result
}

FalsificationTest {
  description: executable or observable check
  estimatedCost?: non-negative finite metrics
  risk?: read-only | reversible | irreversible
}
```

A useful prediction distinguishes mechanisms. “The test may pass or fail” is not differentiating.

## Status transitions

Statuses are `live`, `falsified`, `dominated`, `selected`, and `deferred`.

- A falsified hypothesis must be reopened in a separate event with a nonempty reason and new verified evidence before it can be considered for selection.
- An unverified note cannot reopen a falsified hypothesis.
- Confidence must be finite and between 0 and 1 inclusive.
- Read operations are deterministic and side-effect free.

## External verification

A valid tool response proves only that the state transition satisfied the schema. The task decision still requires an external observation—such as a test result, environment state, or inspected artifact—linked back through an existing evidence reference.

## Source provenance

Exact source hashes and symbol locators are frozen in `skills/evidence-harness/references/source-manifest.json`.

- `src/hypotheses.ts`: `HypothesisMutationInput`, `HypothesisReadInput`, `validateEvidence`, `applyHypothesisMutation`, and `readHypotheses`.
- `src/types.ts`: `EvidenceRefV1`, `PredictionV1`, `FalsificationTestV1`, `HypothesisV1`, and `HypothesisOperation`.
- `docs/CURRENTPLAN.md`, routing criteria and acceptance gate: Workstream G, “Skill” and “Acceptance gate.”
