import assert from "node:assert/strict";
import test from "node:test";
import { mergeRanges } from "./src/ranges.mjs";

test("merges overlapping ranges in sorted order", () => {
  assert.deepEqual(
    mergeRanges([
      [8, 12],
      [1, 4],
      [3, 6],
      [10, 14],
    ]),
    [
      [1, 6],
      [8, 14],
    ],
  );
});

test("does not merge adjacent inclusive ranges", () => {
  assert.deepEqual(
    mergeRanges([
      [1, 2],
      [3, 5],
    ]),
    [
      [1, 2],
      [3, 5],
    ],
  );
});

test("handles contained ranges", () => {
  assert.deepEqual(
    mergeRanges([
      [2, 9],
      [4, 5],
      [9, 12],
    ]),
    [[2, 12]],
  );
});

test("does not mutate the input or nested ranges", () => {
  const input = [
    [5, 7],
    [1, 3],
  ];
  const snapshot = structuredClone(input);
  mergeRanges(input);
  assert.deepEqual(input, snapshot);
});

test("rejects malformed ranges", () => {
  for (const invalid of [
    [[1]],
    [[3, 2]],
    [[1, Number.POSITIVE_INFINITY]],
    [["1", 2]],
  ]) {
    assert.throws(() => mergeRanges(invalid), TypeError);
  }
});
