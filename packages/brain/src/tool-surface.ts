export const BRAIN_READ_COMMANDS = ["help", "list", "get", "timeline", "query", "doctor"] as const;

export const BRAIN_RETRIEVAL_COMMANDS = ["query", "get", "timeline", "list"] as const;

export type BrainReadCommand = (typeof BRAIN_READ_COMMANDS)[number];
export type BrainRetrievalCommand = (typeof BRAIN_RETRIEVAL_COMMANDS)[number];
export type BrainToolFlagValue = string | number | boolean | string[];

export type BrainReadToolInput = {
  command: BrainReadCommand;
  flags?: Record<string, BrainToolFlagValue>;
  stdin?: string;
};

export const BRAIN_TOOL_FLAG_VALUE_JSON_SCHEMA = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "array", items: { type: "string" } },
  ],
};

export const BRAIN_READ_TOOL_INPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    command: {
      type: "string",
      enum: [...BRAIN_READ_COMMANDS],
      description:
        "Read-only opencompany Brain command. Use query for recall/search, list for inventory, get for known ids, timeline for dated evidence, doctor for validation, and help for usage.",
    },
    flags: {
      type: "object",
      properties: {
        id: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
          ],
          description:
            "Document id. Pass one id for timeline, or one id/a list of up to 20 ids for get.",
        },
        text: {
          type: "string",
          description:
            "Query text for semantic and keyword search. Omit only for a recency-ordered browse.",
        },
        folder: {
          type: "string",
          description: "Optional Brain folder filter for query or list.",
        },
        type: {
          type: "string",
          description:
            "Optional Brain entity type filter for query or list, such as person, company, project, or note.",
        },
        kind: {
          type: "string",
          enum: ["page", "evidence"],
          description:
            'Query/list document kind. Query defaults to "page"; use "evidence" only for an explicit raw-source lookup.',
        },
        since: {
          type: "string",
          description:
            "Lower updated-at bound for query/timeline, such as 6h, 2d, 1w, or an ISO timestamp.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum query hits to return in this page. Defaults to 10.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description:
            "Zero-based query result offset. When pagination.hasMore is true, repeat the same query with pagination.nextOffset.",
        },
        hops: {
          type: "number",
          minimum: 0,
          description: "Optional graph expansion depth for query.",
        },
        "include-neighbors": {
          type: "boolean",
          description: "Whether query hits should include linked Brain records.",
        },
        "snippet-chars": {
          type: "number",
          minimum: 0,
          description: "Maximum snippet length for each query hit.",
        },
        "lexical-only": {
          type: "boolean",
          description: "Use keyword ranking without semantic embeddings for query.",
        },
        "include-merged": {
          type: "boolean",
          description: "Include merged records in query or list.",
        },
        "include-archived": {
          type: "boolean",
          description: "Include archived records in query.",
        },
      },
      additionalProperties: BRAIN_TOOL_FLAG_VALUE_JSON_SCHEMA,
      description:
        'CLI flags for the command, without leading dashes. Query defaults to kind "page". Query output includes pagination; when hasMore is true, repeat the same query with offset set to nextOffset.',
    },
    stdin: {
      type: "string",
      description: "Optional stdin; read-only opencompany Brain commands do not normally need it.",
    },
  },
  required: ["command"],
};

export const BRAIN_RETRIEVAL_TOOL_INPUT_JSON_SCHEMA = {
  ...BRAIN_READ_TOOL_INPUT_JSON_SCHEMA,
  properties: {
    ...BRAIN_READ_TOOL_INPUT_JSON_SCHEMA.properties,
    command: {
      ...BRAIN_READ_TOOL_INPUT_JSON_SCHEMA.properties.command,
      enum: [...BRAIN_RETRIEVAL_COMMANDS],
      description:
        "Read-only opencompany Brain command. Use query for recall/search, list for inventory, get for known ids, and timeline for dated evidence.",
    },
  },
};

export const BRAIN_READ_TOOL_DESCRIPTION =
  "Read-only access to the user's durable opencompany Brain. Use it to recall and inspect existing knowledge, never to write. Arguments are { command, flags }: use query with flags.text for recall/search, list with optional flags.folder/type for inventory, get with flags.id for known Brain ids, and timeline with flags.id for a record's history. Query returns curated pages by default; pass kind: \"evidence\" only when raw source material is explicitly needed. Use query with since windows like 6h, 2d, 1w, or an ISO timestamp to search or browse recent Brain pages; omit text when the user only wants recent entries. Query output includes pagination. When pagination.hasMore is true, repeat the same query with all filters unchanged and offset set to pagination.nextOffset. Use includeMerged only when inspecting duplicate/merged history and includeArchived only for retired records. Do not treat Brain as a chat scratchpad.";

export const CODEX_BRAIN_TOOL_CONTRACT_VERSION = "goat-codex-brain.v1";

export function normalizeBrainReadToolInput(input: unknown): BrainReadToolInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("brain command is required.");
  }
  const record = input as Record<string, unknown>;
  const command = normalizeBrainReadCommand(record.command);
  if (!command) throw new Error("brain command is invalid.");
  const flags = normalizeBrainFlags(record.flags);
  const stdin = typeof record.stdin === "string" ? record.stdin : "";
  return {
    command,
    ...(Object.keys(flags).length > 0 ? { flags } : {}),
    ...(stdin ? { stdin } : {}),
  };
}

export function isBrainRetrievalCommand(value: BrainReadCommand): value is BrainRetrievalCommand {
  return (BRAIN_RETRIEVAL_COMMANDS as readonly string[]).includes(value);
}

function normalizeBrainReadCommand(value: unknown): BrainReadCommand | null {
  if (typeof value !== "string") return null;
  return (BRAIN_READ_COMMANDS as readonly string[]).includes(value)
    ? (value as BrainReadCommand)
    : null;
}

function normalizeBrainFlags(value: unknown): Record<string, BrainToolFlagValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, BrainToolFlagValue> = {};
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
