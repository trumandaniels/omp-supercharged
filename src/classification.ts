import type { ProjectPolicyV1, ToolClassification } from "./types.ts";

export interface ClassificationResult {
  classification: ToolClassification;
  classifier: string;
  identityLabel: string;
}

interface ToolLikeEvent {
  toolName: string;
  input: Record<string, unknown>;
}

const BUILTIN_READ_TOOLS: Record<string, true> = {
  read: true,
  grep: true,
  glob: true,
  web_search: true,
};

const BUILTIN_VERIFICATION_RULES: Array<{ label: string; regex: RegExp }> = [
  { label: "bun-test", regex: /^bun test(?:\s|$)/u },
  {
    label: "bun-check-script",
    regex: /^bun run (?:test|check|typecheck|lint|build)(?:\s|$)/u,
  },
  { label: "pytest", regex: /^(?:pytest|python(?:3)? -m pytest)(?:\s|$)/u },
  { label: "go-check", regex: /^go (?:test|vet)(?:\s|$)/u },
  {
    label: "protected-cargo-check",
    regex: /^sfw cargo (?:test|check|clippy)(?:\s|$)/u,
  },
  { label: "omp-plugin-doctor", regex: /^omp plugin doctor(?:\s|$)/u },
];

const BUILTIN_MUTATION_RULES: Array<{ label: string; regex: RegExp }> = [
  {
    label: "formatter-write",
    regex: /^(?:biome|prettier|eslint)(?:\s|$).*?(?:--write|--fix)(?:\s|$)/u,
  },
  {
    label: "git-worktree-mutation",
    regex: /^git (?:apply|checkout|restore|reset|clean)(?:\s|$)/u,
  },
];

const BUILTIN_READ_COMMANDS: Array<{ label: string; regex: RegExp }> = [
  {
    label: "git-inspection",
    regex: /^git (?:status|diff|log|show|rev-parse)(?:\s|$)/u,
  },
  { label: "filesystem-inspection", regex: /^(?:pwd|stat|wc)(?:\s|$)/u },
];

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/gu, " ");
}

function firstPatternMatch(
  patterns: readonly string[],
  command: string,
): number {
  for (let index = 0; index < patterns.length; index++) {
    if (new RegExp(patterns[index], "u").test(command)) return index;
  }
  return -1;
}

export function classifyShellCommand(
  command: string,
  policy: ProjectPolicyV1,
): ClassificationResult {
  const normalized = normalizeCommand(command);
  const ignored = firstPatternMatch(
    policy.verification.ignoreCommandPatterns,
    normalized,
  );
  if (ignored >= 0)
    return {
      classification: "ignored",
      classifier: `project-ignore:${ignored}`,
      identityLabel: "shell",
    };
  const verification = firstPatternMatch(
    policy.verification.commandPatterns,
    normalized,
  );
  if (verification >= 0)
    return {
      classification: "verification",
      classifier: `project-verification:${verification}`,
      identityLabel: "shell",
    };
  const mutation = firstPatternMatch(
    policy.verification.mutationCommandPatterns,
    normalized,
  );
  if (mutation >= 0)
    return {
      classification: "mutation",
      classifier: `project-mutation:${mutation}`,
      identityLabel: "shell",
    };
  for (const rule of BUILTIN_MUTATION_RULES) {
    if (rule.regex.test(normalized))
      return {
        classification: "mutation",
        classifier: `builtin:${rule.label}`,
        identityLabel: "shell",
      };
  }
  for (const rule of BUILTIN_VERIFICATION_RULES) {
    if (rule.regex.test(normalized))
      return {
        classification: "verification",
        classifier: `builtin:${rule.label}`,
        identityLabel: "shell",
      };
  }
  for (const rule of BUILTIN_READ_COMMANDS) {
    if (rule.regex.test(normalized))
      return {
        classification: "read",
        classifier: `builtin:${rule.label}`,
        identityLabel: "shell",
      };
  }
  return {
    classification: "unknown",
    classifier: "builtin:unknown-shell",
    identityLabel: "shell",
  };
}

function parseDevicePayload(
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof input.content !== "string") return undefined;
  try {
    const value = JSON.parse(input.content);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function classifyLspAction(
  input: Record<string, unknown>,
): ClassificationResult {
  const action = typeof input.action === "string" ? input.action : "unknown";
  if (action === "rename" || action === "rename_file") {
    return input.apply === false
      ? {
          classification: "read",
          classifier: `builtin:lsp-${action}-preview`,
          identityLabel: `lsp:${action}`,
        }
      : {
          classification: "mutation",
          classifier: `builtin:lsp-${action}`,
          identityLabel: `lsp:${action}`,
        };
  }
  if (action === "code_actions") {
    return input.apply === true
      ? {
          classification: "mutation",
          classifier: "builtin:lsp-code-action-apply",
          identityLabel: "lsp:code_actions",
        }
      : {
          classification: "read",
          classifier: "builtin:lsp-code-action-list",
          identityLabel: "lsp:code_actions",
        };
  }
  const readActions: Record<string, true> = {
    capabilities: true,
    definition: true,
    diagnostics: true,
    hover: true,
    implementation: true,
    references: true,
    status: true,
    symbols: true,
    type_definition: true,
  };
  if (readActions[action])
    return {
      classification: "read",
      classifier: `builtin:lsp-${action}`,
      identityLabel: `lsp:${action}`,
    };
  return {
    classification: "unknown",
    classifier: "builtin:unknown-lsp-action",
    identityLabel: `lsp:${action}`,
  };
}

function classifyTask(input: Record<string, unknown>): ClassificationResult {
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    return {
      classification: "unknown",
      classifier: "builtin:unknown-task",
      identityLabel: "task",
    };
  }
  const readOnly = input.tasks.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    return (item as Record<string, unknown>).agent === "scout";
  });
  return readOnly
    ? {
        classification: "read",
        classifier: "builtin:read-only-scout-batch",
        identityLabel: "task:scout",
      }
    : {
        classification: "mutation",
        classifier: "builtin:conservative-task-batch",
        identityLabel: "task",
      };
}

export function classifyToolCall(
  event: ToolLikeEvent,
  policy: ProjectPolicyV1,
): ClassificationResult {
  if (event.toolName === "bash") {
    return typeof event.input.command === "string"
      ? classifyShellCommand(event.input.command, policy)
      : {
          classification: "unknown",
          classifier: "builtin:missing-shell-command",
          identityLabel: "shell",
        };
  }
  if (event.toolName === "edit")
    return {
      classification: "mutation",
      classifier: "builtin:edit",
      identityLabel: "edit",
    };
  if (event.toolName === "ast_edit")
    return {
      classification: "mutation",
      classifier: "builtin:ast-edit",
      identityLabel: "ast_edit",
    };
  if (event.toolName === "lsp") return classifyLspAction(event.input);
  if (event.toolName === "task") return classifyTask(event.input);
  if (event.toolName === "write") {
    const path = typeof event.input.path === "string" ? event.input.path : "";
    if (path === "xd://ast_edit")
      return {
        classification: "mutation",
        classifier: "builtin:ast-edit-device",
        identityLabel: "ast_edit",
      };
    if (path === "xd://lsp")
      return classifyLspAction(parseDevicePayload(event.input) ?? {});
    if (path.startsWith("xd://"))
      return {
        classification: "unknown",
        classifier: "builtin:non-filesystem-device",
        identityLabel: path.slice(5),
      };
    return {
      classification: "mutation",
      classifier: "builtin:write",
      identityLabel: "write",
    };
  }
  if (BUILTIN_READ_TOOLS[event.toolName]) {
    return {
      classification: "read",
      classifier: `builtin:${event.toolName}`,
      identityLabel: event.toolName,
    };
  }
  return {
    classification: "unknown",
    classifier: "builtin:unknown-tool",
    identityLabel: event.toolName,
  };
}
