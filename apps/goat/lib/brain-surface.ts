import type {
  GoatBrainCliCommand,
  GoatBrainToolFlagValue,
  GoatBrainToolInput,
} from "@/lib/chat-ui";

// Shared read-only Goat Brain tool surface for main chat and the per-brain MCP connector.
// Keep command and input normalization here so both consumers expose the same retrieval contract.
export const GOAT_BRAIN_READ_COMMANDS = [
  "help",
  "list",
  "get",
  "timeline",
  "query",
  "doctor",
] as const satisfies readonly GoatBrainCliCommand[];

// Commands served by the DB read plane (@opencompany/db/goat-brain-read): indexed SQL, no brain
// materialization, no CLI spawn. `help` and `doctor` stay on the CLI.
export const GOAT_BRAIN_READ_PLANE_COMMANDS = [
  "query",
  "get",
  "timeline",
  "list",
] as const satisfies readonly GoatBrainCliCommand[];

export const GOAT_BRAIN_TOOL_FLAG_VALUE_JSON_SCHEMA = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "array", items: { type: "string" } },
  ],
};

export const GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: {
      type: "string",
      enum: [...GOAT_BRAIN_READ_COMMANDS],
      description:
        "Read-only Goat Brain command. Use query for recall/search, list for inventory, get for known ids, timeline for dated evidence, doctor for validation, and help for usage.",
    },
    flags: {
      type: "object",
      additionalProperties: GOAT_BRAIN_TOOL_FLAG_VALUE_JSON_SCHEMA,
      description:
        "CLI flags for the command, without leading dashes. Query/timeline since accepts relative windows like 6h, 2d, 1w or an ISO-8601 timestamp.",
    },
    stdin: {
      type: "string",
      description: "Optional stdin; read-only Goat Brain commands do not normally need it.",
    },
  },
  required: ["command"],
};

export type GoatBrainMultiBrainTarget = {
  brainRef: string;
  brainName: string;
};

// Single-brain surfaces use the shared read-tool schema unchanged; when
// several brains are in scope the model must pick one per call via a required
// `brain` enum (one tool, not N mangled tool names).
export function buildGoatBrainMultiBrainToolSchema(brains: readonly GoatBrainMultiBrainTarget[]) {
  if (brains.length <= 1) return GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA;
  return {
    ...GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
    properties: {
      ...GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA.properties,
      brain: {
        type: "string",
        enum: brains.map((brain) => brain.brainRef),
        description: `Which brain to search. ${brains
          .map((brain) => `${brain.brainName}: ${brain.brainRef}`)
          .join("; ")}`,
      },
    },
    required: [...GOAT_BRAIN_READ_TOOL_INPUT_JSON_SCHEMA.required, "brain"],
  };
}

export function normalizeGoatBrainReadToolInput(input: unknown): GoatBrainToolInput {
  if (!input || typeof input !== "object") {
    throw new Error("goat_brain command is required.");
  }
  const record = input as Record<string, unknown>;
  const command = normalizeGoatBrainReadCommand(record.command);
  if (!command) throw new Error("goat_brain command is invalid.");
  const flags = normalizeGoatBrainFlags(record.flags);
  const stdin = typeof record.stdin === "string" ? record.stdin : "";
  return {
    command,
    ...(Object.keys(flags).length > 0 ? { flags } : {}),
    ...(stdin ? { stdin } : {}),
  };
}

function normalizeGoatBrainReadCommand(value: unknown): GoatBrainCliCommand | null {
  if (typeof value !== "string") return null;
  return (GOAT_BRAIN_READ_COMMANDS as readonly string[]).includes(value)
    ? (value as GoatBrainCliCommand)
    : null;
}

function normalizeGoatBrainFlags(value: unknown): Record<string, GoatBrainToolFlagValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, GoatBrainToolFlagValue> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!key.trim()) continue;
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed) out[key] = trimmed;
      continue;
    }
    if (typeof raw === "number") {
      if (Number.isFinite(raw)) out[key] = raw;
      continue;
    }
    if (typeof raw === "boolean") {
      out[key] = raw;
      continue;
    }
    if (Array.isArray(raw)) {
      const values = raw.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      );
      if (values.length > 0) out[key] = values.map((item) => item.trim());
    }
  }
  return out;
}
