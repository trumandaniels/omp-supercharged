import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import type { JsonValue } from "./types.ts";
import { canonicalJson } from "./canonical.ts";

export interface HarnessPaths {
  stateRoot: string;
  dataRoot: string;
  runsRoot: string;
  artifactsRoot: string;
  componentsRoot: string;
  modelsRoot: string;
}

export interface RunPaths extends HarnessPaths {
  runId: string;
  runDirectory: string;
  ledgerPath: string;
  manifestPath: string;
}

function resolveXdgRoot(
  variable: string | undefined,
  fallback: string,
): string {
  if (variable && isAbsolute(variable)) return variable;
  return fallback;
}

export function resolveHarnessPaths(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): HarnessPaths {
  if (!home || !isAbsolute(home))
    throw new Error(
      "A valid absolute home directory is required for harness state",
    );
  const stateBase = resolveXdgRoot(
    environment.XDG_STATE_HOME,
    join(home, ".local", "state"),
  );
  const dataBase = resolveXdgRoot(
    environment.XDG_DATA_HOME,
    join(home, ".local", "share"),
  );
  const stateRoot = join(stateBase, "omp-supercharged");
  const dataRoot = join(dataBase, "omp-supercharged");
  return {
    stateRoot,
    dataRoot,
    runsRoot: join(stateRoot, "runs"),
    artifactsRoot: join(dataRoot, "artifacts", "sha256"),
    componentsRoot: join(dataRoot, "components", "sha256"),
    modelsRoot: join(dataRoot, "models", "sha256"),
  };
}

export function resolveRunPaths(
  runId: string,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): RunPaths {
  if (!/^run-[A-Za-z0-9-]+$/.test(runId))
    throw new Error("Invalid run ID for state path");
  const base = resolveHarnessPaths(environment, home);
  const runDirectory = join(base.runsRoot, runId);
  return {
    ...base,
    runId,
    runDirectory,
    ledgerPath: join(runDirectory, "events.jsonl"),
    manifestPath: join(runDirectory, "manifest.json"),
  };
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

export async function writePrivateAtomic(
  path: string,
  value: JsonValue | string,
): Promise<void> {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const directory = separator >= 0 ? path.slice(0, separator) : ".";
  await ensurePrivateDirectory(directory);
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const content =
    typeof value === "string" ? value : `${canonicalJson(value)}\n`;
  await writeFile(temporaryPath, content, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}
