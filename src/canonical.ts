import { createHash, randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "./types.ts";

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function toCanonicalValue(
  value: unknown,
  seen: Set<object> = new Set(),
): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON rejects non-finite numbers");
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON rejects ${typeof value} values`);
  }
  if (seen.has(value))
    throw new TypeError("Canonical JSON rejects cyclic values");
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => toCanonicalValue(item, seen));
    if (!isPlainObject(value))
      throw new TypeError(
        "Canonical JSON accepts only arrays and plain objects",
      );
    const output: JsonObject = Object.create(null) as JsonObject;
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined)
        throw new TypeError(`Canonical JSON rejects undefined at ${key}`);
      output[key] = toCanonicalValue(item, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

export function sha256Bytes(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashJson(value: unknown): string {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function isoNow(clock: () => number = Date.now): string {
  return new Date(clock()).toISOString();
}

export function assertFiniteUnitInterval(
  value: unknown,
  field: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new TypeError(`${field} must be a finite number between 0 and 1`);
  }
}

export function assertNonEmptyString(
  value: unknown,
  field: string,
  maxLength = 16_384,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${field} must be non-empty`);
  if (value.length > maxLength)
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}
