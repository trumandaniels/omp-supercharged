import { open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  canonicalJson,
  isoNow,
  newId,
  sha256Bytes,
  toCanonicalValue,
} from "./canonical.ts";
import { validateRunEvent } from "./event-schema.ts";
import { ensurePrivateDirectory, type RunPaths } from "./paths.ts";
import type { JsonObject, RunEventDraftV1, RunEventV1 } from "./types.ts";

export interface LedgerRecoveryV1 {
  version: 1;
  events: RunEventV1[];
  truncatedTail?: string;
}

export async function recoverLedger(path: string): Promise<LedgerRecoveryV1> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, events: [] };
    throw error;
  }
  if (content.length === 0) return { version: 1, events: [] };
  const hasCompleteTail = content.endsWith("\n");
  const lines = content.split("\n");
  let truncatedTail: string | undefined;
  if (hasCompleteTail) lines.pop();
  else truncatedTail = lines.pop() ?? "";
  const events: RunEventV1[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.length === 0)
      throw new Error(`Ledger contains an empty line at ${index + 1}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Ledger line ${index + 1} is invalid JSON: ${String(error)}`,
      );
    }
    validateRunEvent(parsed);
    const expectedSequence = index + 1;
    if (parsed.sequence !== expectedSequence)
      throw new Error(
        `Ledger sequence ${parsed.sequence} does not match expected ${expectedSequence}`,
      );
    if (events.length > 0 && parsed.runId !== events[0].runId)
      throw new Error(`Ledger line ${index + 1} changes run ID`);
    events.push(parsed);
  }
  return truncatedTail === undefined
    ? { version: 1, events }
    : { version: 1, events, truncatedTail };
}

export class RunLedger {
  readonly runId: string;
  readonly paths: RunPaths;
  #handle: FileHandle;
  #tail: Promise<void> = Promise.resolve();
  #sequence: number;
  #healthy = true;
  #failure?: string;
  #closed = false;
  #clock: () => number;
  #idFactory: (prefix: string) => string;

  private constructor(
    runId: string,
    paths: RunPaths,
    handle: FileHandle,
    sequence: number,
    clock: () => number,
    idFactory: (prefix: string) => string,
  ) {
    this.runId = runId;
    this.paths = paths;
    this.#handle = handle;
    this.#sequence = sequence;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  static async create(
    paths: RunPaths,
    options: {
      clock?: () => number;
      idFactory?: (prefix: string) => string;
    } = {},
  ): Promise<RunLedger> {
    await ensurePrivateDirectory(paths.runDirectory);
    const recovery = await recoverLedger(paths.ledgerPath);
    if (recovery.truncatedTail !== undefined) {
      throw new Error(
        "Refusing to append to a ledger with a truncated tail; preserve it for recovery inspection",
      );
    }
    if (recovery.events.length > 0 && recovery.events[0].runId !== paths.runId)
      throw new Error("Ledger run ID does not match path");
    const handle = await open(paths.ledgerPath, "a+", 0o600);
    if (process.platform !== "win32") await handle.chmod(0o600);
    return new RunLedger(
      paths.runId,
      paths,
      handle,
      recovery.events.length,
      options.clock ?? Date.now,
      options.idFactory ?? newId,
    );
  }

  get healthy(): boolean {
    return this.#healthy;
  }

  get failure(): string | undefined {
    return this.#failure;
  }

  get eventCount(): number {
    return this.#sequence;
  }

  append(draft: RunEventDraftV1, critical = false): Promise<RunEventV1> {
    if (this.#closed) return Promise.reject(new Error("Ledger is closed"));
    const operation = this.#tail.then(async () => {
      if (!this.#healthy)
        throw new Error(
          `Ledger is unhealthy: ${this.#failure ?? "unknown failure"}`,
        );
      const event = {
        ...draft,
        version: 1,
        eventId: this.#idFactory("event"),
        runId: this.runId,
        sequence: this.#sequence + 1,
        occurredAt: draft.occurredAt ?? isoNow(this.#clock),
      } as RunEventV1;
      toCanonicalValue(event);
      validateRunEvent(event);
      try {
        await this.#handle.appendFile(`${canonicalJson(event)}\n`, "utf8");
        if (critical) await this.#handle.sync();
        this.#sequence = event.sequence;
        return event;
      } catch (error) {
        this.#healthy = false;
        this.#failure = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async flush(): Promise<void> {
    await this.#tail;
    if (!this.#healthy)
      throw new Error(
        `Ledger is unhealthy: ${this.#failure ?? "unknown failure"}`,
      );
    await this.#handle.sync();
  }

  async readCanonical(): Promise<RunEventV1[]> {
    await this.flush();
    const recovery = await recoverLedger(this.paths.ledgerPath);
    if (recovery.truncatedTail !== undefined)
      throw new Error("Ledger developed a truncated tail");
    return recovery.events;
  }

  async hash(): Promise<string> {
    await this.flush();
    return sha256Bytes(await readFile(this.paths.ledgerPath));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
    try {
      if (this.#healthy) await this.#handle.sync();
    } finally {
      await this.#handle.close();
    }
  }
}

export function eventData(value: unknown): JsonObject {
  const canonical = toCanonicalValue(value);
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical))
    throw new TypeError("Event data must be an object");
  return canonical;
}
