import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, hashJson } from "../src/canonical.ts";
import { validateRunEvent } from "../src/event-schema.ts";
import { recoverLedger, RunLedger } from "../src/ledger.ts";
import { resolveRunPaths } from "../src/paths.ts";
import type { RunEventDraftV1, RunEventV1 } from "../src/types.ts";

const NOW = "2026-07-20T12:00:00.000Z";

function runStartedDraft(): RunEventDraftV1 {
  return {
    kind: "run_started",
    status: "started",
    sessionRef: "session-test",
    data: {
      extensionVersion: "0.1.0",
      cwdHash: hashJson({ cwd: "/workspace" }),
      policyHash: hashJson({ policy: 1 }),
      systemPromptHash: hashJson(["system"]),
      evaluationCondition: "ledger",
    },
  };
}

test("canonical JSON is stable and rejects values outside the JSON contract", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, x: null } }),
    '{"a":{"x":null,"y":true},"z":1}',
  );
  assert.equal(hashJson({ b: 2, a: 1 }), hashJson({ a: 1, b: 2 }));
  const prototypeKeys = JSON.parse(
    '{"__proto__":{"safe":true},"constructor":1,"toString":2}',
  );
  assert.equal(
    canonicalJson(prototypeKeys),
    '{"__proto__":{"safe":true},"constructor":1,"toString":2}',
  );
  assert.notEqual(
    hashJson(prototypeKeys),
    hashJson(
      JSON.parse('{"__proto__":{"safe":false},"constructor":1,"toString":2}'),
    ),
  );
  assert.throws(
    () => canonicalJson({ value: undefined } as never),
    /undefined/u,
  );
  assert.throws(() => canonicalJson({ value: Number.NaN } as never), /finite/u);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic as never), /circular|cyclic|stack/i);
});

test("event validation requires complete, internally consistent contracts", () => {
  const valid: RunEventV1 = {
    ...runStartedDraft(),
    version: 1,
    eventId: "event-1",
    runId: "run-schema",
    sequence: 1,
    occurredAt: NOW,
  } as RunEventV1;
  assert.doesNotThrow(() => validateRunEvent(valid));
  const missingHash = structuredClone(valid) as unknown as {
    data: Record<string, unknown>;
  };
  delete missingHash.data.systemPromptHash;
  assert.throws(
    () => validateRunEvent(missingHash),
    /requires systemPromptHash/u,
  );
  const inheritedHash = structuredClone(valid) as unknown as {
    data: Record<string, unknown>;
  };
  const systemPromptHash = inheritedHash.data.systemPromptHash;
  delete inheritedHash.data.systemPromptHash;
  Object.setPrototypeOf(inheritedHash.data, { systemPromptHash });
  assert.equal(inheritedHash.data.systemPromptHash, systemPromptHash);
  assert.throws(
    () => validateRunEvent(inheritedHash),
    /requires systemPromptHash/u,
  );
  const wrongStatus = { ...valid, status: "ok" };
  assert.throws(() => validateRunEvent(wrongStatus), /invalid status/u);
  const extraField = structuredClone(valid) as unknown as {
    data: Record<string, unknown>;
  };
  extraField.data.rawPrompt = "secret";
  assert.throws(() => validateRunEvent(extraField), /unknown field rawPrompt/u);
  for (const key of ["constructor", "toString", "__proto__"]) {
    const field = JSON.parse(`{${JSON.stringify(key)}:true}`);
    const unknownEnvelope = {
      ...structuredClone(valid),
      ...field,
    } as unknown as RunEventV1;
    assert.equal(Object.hasOwn(unknownEnvelope, key), true);
    assert.throws(
      () => validateRunEvent(unknownEnvelope),
      new RegExp(`unknown field ${key}`, "u"),
    );

    const unknownData = {
      ...structuredClone(valid),
      data: { ...structuredClone(valid.data), ...field },
    } as unknown as RunEventV1;
    assert.equal(Object.hasOwn(unknownData.data, key), true);
    assert.throws(
      () => validateRunEvent(unknownData),
      new RegExp(`unknown field ${key}`, "u"),
    );

    const prototypeStatus = {
      ...valid,
      status: key,
    } as unknown as RunEventV1;
    assert.throws(
      () => validateRunEvent(prototypeStatus),
      /Unknown run event status/u,
    );
    const prototypeKind = {
      ...valid,
      kind: key,
    } as unknown as RunEventV1;
    assert.throws(
      () => validateRunEvent(prototypeKind),
      /Unknown run event kind/u,
    );
  }
  const lineage: RunEventV1 = {
    version: 1,
    eventId: "event-2",
    runId: "run-schema",
    sequence: 2,
    occurredAt: new Date(Date.parse(NOW) + 1_000).toISOString(),
    kind: "session_lineage",
    status: "ok",
    data: {
      reason: "branch",
      previousSessionHash: "none",
      invalidatesVerification: true,
      policyHash: hashJson({ policy: 2 }),
    },
  };
  assert.doesNotThrow(() => validateRunEvent(lineage));
  const lineageWithoutPolicy = structuredClone(lineage) as unknown as {
    data: Record<string, unknown>;
  };
  delete lineageWithoutPolicy.data.policyHash;
  assert.throws(
    () => validateRunEvent(lineageWithoutPolicy),
    /requires policyHash/u,
  );
});

test("ledger serializes concurrent appends, persists owner-only files, and exposes truncated tails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "omp-supercharged-ledger-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const paths = resolveRunPaths(
    "run-ledger-test",
    { XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data") },
    root,
  );
  let identifier = 0;
  const ledger = await RunLedger.create(paths, {
    clock: () => Date.parse(NOW) + identifier,
    idFactory: (prefix) => `${prefix}-${++identifier}`,
  });
  await ledger.append(runStartedDraft(), true);
  const appends = Array.from({ length: 24 }, (_, turnIndex) =>
    ledger.append({
      kind: "turn_started",
      status: "started",
      turnId: String(turnIndex),
      data: { turnIndex },
    }),
  );
  const appended = await Promise.all(appends);
  assert.deepEqual(
    appended.map((event) => event.sequence),
    Array.from({ length: 24 }, (_, index) => index + 2),
  );
  await ledger.flush();
  const events = await ledger.readCanonical();
  assert.equal(events.length, 25);
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: 25 }, (_, index) => index + 1),
  );
  assert.equal(events[0].kind, "run_started");
  await ledger.close();

  if (process.platform !== "win32") {
    assert.equal((await stat(paths.runDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.ledgerPath)).mode & 0o777, 0o600);
  }
  const persisted = await readFile(paths.ledgerPath, "utf8");
  assert.equal(persisted.split("\n").filter(Boolean).length, 25);
  await appendFile(paths.ledgerPath, '{"version":1', "utf8");
  const recovery = await recoverLedger(paths.ledgerPath);
  assert.equal(recovery.events.length, 25);
  assert.equal(recovery.truncatedTail, '{"version":1');
  await assert.rejects(RunLedger.create(paths), /truncated tail/u);
});
