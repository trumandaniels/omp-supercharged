import assert from "node:assert/strict";
import test from "node:test";
import { retry } from "./src/retry.mjs";

test("uses one-based attempt numbers and returns the eventual value", async () => {
  const attempts = [];
  const value = await retry(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) throw new Error(`transient-${attempt}`);
      return "ready";
    },
    { maxAttempts: 3 },
  );
  assert.equal(value, "ready");
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("throws the last error after exactly maxAttempts calls", async () => {
  const seen = [];
  await assert.rejects(
    retry(
      async (attempt) => {
        seen.push(attempt);
        throw new Error(`failure-${attempt}`);
      },
      { maxAttempts: 2 },
    ),
    /failure-2/u,
  );
  assert.deepEqual(seen, [1, 2]);
});

test("stops immediately when shouldRetry rejects the error", async () => {
  let calls = 0;
  const fatal = new TypeError("fatal");
  await assert.rejects(
    retry(
      async () => {
        calls++;
        throw fatal;
      },
      { maxAttempts: 4, shouldRetry: (error) => !(error instanceof TypeError) },
    ),
    (error) => error === fatal,
  );
  assert.equal(calls, 1);
});

test("validates its public contract before invoking operation", async () => {
  const operation = async () => "unused";
  await assert.rejects(retry(null), /operation/u);
  for (const maxAttempts of [0, 1.5, "2"]) {
    await assert.rejects(retry(operation, { maxAttempts }), /maxAttempts/u);
  }
  await assert.rejects(
    retry(operation, { maxAttempts: 2, shouldRetry: true }),
    /shouldRetry/u,
  );
});
