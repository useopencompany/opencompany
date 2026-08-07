import { randomUUID } from "node:crypto";
import {
  GOAT_BRAIN_ENTITY_TYPES,
  GOAT_BRAIN_READ_TOOL_DESCRIPTION,
  GOAT_BRAIN_RETRIEVAL_TOOL_INPUT_JSON_SCHEMA,
  type GoatBrainReadToolInput,
  type GoatBrainRetrievalCommand,
  type GoatBrainToolFlagValue,
  isBuiltInGoatBrainEntityType,
  isGoatBrainRetrievalCommand,
  isValidGoatBrainKind,
  normalizeGoatBrainFolderForV1,
  normalizeGoatBrainReadToolInput,
} from "@opencompany/brain";
import type { GoatBrainToolInput, GoatBrainToolOutput } from "@opencompany/core/chat-ui";
import {
  getGoatBrainDocuments,
  getGoatBrainTimeline,
  listGoatBrainDocuments,
  searchGoatBrain,
} from "@opencompany/db/brain-read";
import { goatBrainToolRuns } from "@opencompany/db/schema";
import { getGoatBrainAccess } from "@opencompany/db/workspaces";
import { createLogger } from "@opencompany/observability";
import { createGoatGatewayAttribution } from "@opencompany/telemetry";
import type {
  CodexAppServerDynamicTool,
  CodexAppServerDynamicToolCall,
  CodexAppServerDynamicToolResponse,
} from "./codex-app-server";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";

const GOAT_CODEX_BRAIN_TOOL_NAME = "goat_brain";
const GOAT_CODEX_BRAIN_RESULT_MAX_CHARS = 120_000;
const DEFAULT_QUERY_LIMIT = 10;
const MAX_QUERY_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_TIMELINE_LIMIT = 50;
const MAX_GET_IDS = 20;

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-codex-brain-tool" });

type GoatCodexBrainToolContext = {
  brainRef: string;
  userWorkosId: string;
  chatSessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  env: Pick<RunnerEnv, "vercelAiGatewayApiKey">;
  checkAbort: () => Promise<void>;
};

type GoatCodexBrainToolOutput = {
  ok: boolean;
  brainRef: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command?: GoatBrainRetrievalCommand;
  parsed?: unknown;
  error?: string;
  traceId: string;
  durationMs: number;
};

export function createGoatCodexBrainDynamicTool(
  context: GoatCodexBrainToolContext,
): CodexAppServerDynamicTool {
  return {
    spec: {
      type: "function",
      name: GOAT_CODEX_BRAIN_TOOL_NAME,
      description: GOAT_BRAIN_READ_TOOL_DESCRIPTION,
      inputSchema: GOAT_BRAIN_RETRIEVAL_TOOL_INPUT_JSON_SCHEMA,
    },
    execute: (call) => executeGoatCodexBrainTool({ context, call }),
  };
}

export async function executeGoatCodexBrainTool(input: {
  context: GoatCodexBrainToolContext;
  call: CodexAppServerDynamicToolCall;
  dependencies?: Partial<GoatCodexBrainToolDependencies>;
}): Promise<CodexAppServerDynamicToolResponse> {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const db = dependencies.db ?? getDb();
  const startedAt = dependencies.now();
  const traceId = `goat_brain_run_${dependencies.randomId()}`;
  let toolInput: GoatBrainReadToolInput | null = null;
  let output: GoatCodexBrainToolOutput;

  try {
    await input.context.checkAbort();
    const access = await dependencies.getBrainAccess(
      {
        userWorkosId: input.context.userWorkosId,
        brainRef: input.context.brainRef,
      },
      { db },
    );
    if (!access) throw new Error("You no longer have access to this Brain.");

    toolInput = normalizeGoatBrainReadToolInput(input.call.arguments);
    if (!isGoatBrainRetrievalCommand(toolInput.command)) {
      throw new Error(`The Codex Brain tool does not support "${toolInput.command}".`);
    }
    const parsed = await executeReadCommand({
      brainRef: input.context.brainRef,
      userWorkosId: input.context.userWorkosId,
      chatSessionId: input.context.chatSessionId,
      gatewayApiKey: input.context.env.vercelAiGatewayApiKey,
      toolInput: {
        ...toolInput,
        command: toolInput.command,
      },
      db,
      dependencies,
    });
    await input.context.checkAbort();
    const stdout = JSON.stringify(parsed);
    if (stdout.length > GOAT_CODEX_BRAIN_RESULT_MAX_CHARS) {
      throw new Error(
        "The Brain result is too large for this Codex session. Retry with fewer ids or a smaller limit.",
      );
    }
    output = {
      ok: true,
      brainRef: input.context.brainRef,
      exitCode: 0,
      stdout,
      stderr: "",
      command: toolInput.command,
      parsed,
      traceId,
      durationMs: Math.max(0, dependencies.now().getTime() - startedAt.getTime()),
    };
  } catch (error) {
    output = {
      ok: false,
      brainRef: input.context.brainRef,
      exitCode: null,
      stdout: "",
      stderr: "",
      ...(toolInput && isGoatBrainRetrievalCommand(toolInput.command)
        ? { command: toolInput.command }
        : {}),
      error: error instanceof Error ? error.message : "The Brain lookup failed.",
      traceId,
      durationMs: Math.max(0, dependencies.now().getTime() - startedAt.getTime()),
    };
  }

  await recordBrainToolRun({
    db,
    traceId,
    startedAt,
    context: input.context,
    call: input.call,
    toolInput,
    output,
  });

  const modelOutput = output.ok
    ? {
        ok: true,
        brainRef: output.brainRef,
        command: output.command,
        result: output.parsed,
        traceId: output.traceId,
        durationMs: output.durationMs,
      }
    : {
        ok: false,
        brainRef: output.brainRef,
        error: output.error,
        traceId: output.traceId,
        durationMs: output.durationMs,
      };
  return {
    success: output.ok,
    contentItems: [{ type: "inputText", text: JSON.stringify(modelOutput) }],
  };
}

type GoatCodexBrainToolDependencies = {
  db?: any;
  now: () => Date;
  randomId: () => string;
  getBrainAccess: typeof getGoatBrainAccess;
  search: typeof searchGoatBrain;
  getDocuments: typeof getGoatBrainDocuments;
  getTimeline: typeof getGoatBrainTimeline;
  listDocuments: typeof listGoatBrainDocuments;
};

const defaultDependencies: GoatCodexBrainToolDependencies = {
  now: () => new Date(),
  randomId: randomUUID,
  getBrainAccess: getGoatBrainAccess,
  search: searchGoatBrain,
  getDocuments: getGoatBrainDocuments,
  getTimeline: getGoatBrainTimeline,
  listDocuments: listGoatBrainDocuments,
};

// Reusable read-only Brain tool for the opencompany-engine task chat loop. Same
// read plane as the Codex Brain tool, wrapped into the chat GoatBrainToolOutput
// shape so it can be injected as `runBrainCli` into createOpenCompanyChatToolContext.
export async function runGoatTaskBrainRead(input: {
  brainRef: string;
  userWorkosId: string;
  chatSessionId: string;
  gatewayApiKey: string;
  toolInput: GoatBrainToolInput;
  // biome-ignore lint/suspicious/noExplicitAny: matches the file's db handle typing.
  db?: any;
}): Promise<GoatBrainToolOutput> {
  const db = input.db ?? getDb();
  const startedAt = Date.now();
  const traceId = `goat_brain_run_${randomUUID()}`;
  try {
    const access = await getGoatBrainAccess(
      { userWorkosId: input.userWorkosId, brainRef: input.brainRef },
      { db },
    );
    if (!access) throw new Error("You no longer have access to this Brain.");
    const normalized = normalizeGoatBrainReadToolInput(input.toolInput);
    if (!isGoatBrainRetrievalCommand(normalized.command)) {
      throw new Error(`The Brain tool does not support "${normalized.command}".`);
    }
    const parsed = await executeReadCommand({
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      chatSessionId: input.chatSessionId,
      gatewayApiKey: input.gatewayApiKey,
      toolInput: { ...normalized, command: normalized.command },
      db,
      dependencies: defaultDependencies,
    });
    return {
      ok: true,
      brainRef: input.brainRef,
      exitCode: 0,
      stdout: JSON.stringify(parsed),
      stderr: "",
      command: normalized.command,
      parsed,
      traceId,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      brainRef: input.brainRef,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : "The Brain lookup failed.",
      traceId,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}

async function executeReadCommand(input: {
  brainRef: string;
  userWorkosId: string;
  chatSessionId: string;
  gatewayApiKey: string;
  toolInput: GoatBrainReadToolInput & { command: GoatBrainRetrievalCommand };
  db: any;
  dependencies: GoatCodexBrainToolDependencies;
}) {
  const flags = normalizeFlags(input.toolInput.flags ?? {});
  validateFlags(input.toolInput.command, flags);
  const ctx = {
    brainRef: input.brainRef,
    gatewayApiKey: input.gatewayApiKey,
    db: input.db,
    reporting: createGoatGatewayAttribution({
      userWorkosId: input.userWorkosId,
      feature: "brain-query",
      brainRef: input.brainRef,
      chatSessionId: input.chatSessionId,
    }),
  };

  switch (input.toolInput.command) {
    case "query": {
      const text = flagString(flags.text) ?? "";
      const folder = flagString(flags.folder);
      const type = entityTypeFlag(flags.type);
      const kind = kindFlag(flags.kind) ?? "page";
      const since = flagString(flags.since);
      const limit = integerFlag(flags.limit, "limit", 1, MAX_QUERY_LIMIT, DEFAULT_QUERY_LIMIT);
      const offset = integerFlag(flags.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
      const hops = numberFlag(flags.hops);
      const includeNeighbors = booleanFlag(flags["include-neighbors"]);
      const snippetChars = numberFlag(flags["snippet-chars"]);
      const candidates = await input.dependencies.search(ctx, {
        text,
        ...(folder ? { folder: normalizeGoatBrainFolderForV1(folder) } : {}),
        ...(type ? { type } : {}),
        kind,
        ...(since ? { since } : {}),
        limit: limit + 1,
        offset,
        ...(hops !== undefined ? { hops: Math.max(0, hops) } : {}),
        ...(includeNeighbors !== undefined ? { includeNeighbors } : {}),
        ...(snippetChars !== undefined ? { snippetChars } : {}),
        ...(booleanFlag(flags["lexical-only"]) ? { lexicalOnly: true } : {}),
        ...(booleanFlag(flags["include-merged"]) ? { includeMerged: true } : {}),
        ...(booleanFlag(flags["include-archived"]) ? { includeArchived: true } : {}),
      });
      const hits = candidates.slice(0, limit);
      const hasMore = candidates.length > limit;
      return {
        hits,
        mode: text ? "search" : "browse",
        scope: { kind },
        pagination: {
          limit,
          offset,
          returned: hits.length,
          hasMore,
          ...(hasMore
            ? {
                nextOffset: offset + hits.length,
                instruction: `More matches are available. Repeat the same query with all filters unchanged and offset set to ${offset + hits.length}.`,
              }
            : {}),
        },
      };
    }
    case "get": {
      const ids = flagStringList(flags.id);
      if (ids.length === 0) throw new Error("goat_brain get requires an id or list of ids.");
      if (ids.length > MAX_GET_IDS) {
        throw new Error(`goat_brain get accepts at most ${MAX_GET_IDS} ids.`);
      }
      const result = await input.dependencies.getDocuments(ctx, ids);
      if (result.documents.length === 0) {
        throw new Error("No Brain document matched those ids. Use query to find the right id.");
      }
      return result;
    }
    case "timeline": {
      const id = flagString(flags.id);
      if (!id) throw new Error("goat_brain timeline requires an id.");
      const since = flagString(flags.since);
      const limit = integerFlag(flags.limit, "limit", 1, MAX_QUERY_LIMIT, DEFAULT_TIMELINE_LIMIT);
      const result = await input.dependencies.getTimeline(ctx, id, {
        ...(since ? { since } : {}),
        limit,
      });
      if (!result) {
        throw new Error(`No Brain document matched "${id}". Use query to find the right id.`);
      }
      return result;
    }
    case "list": {
      const folder = flagString(flags.folder);
      const type = entityTypeFlag(flags.type);
      const kind = kindFlag(flags.kind);
      const limit = integerFlag(flags.limit, "limit", 1, MAX_QUERY_LIMIT, DEFAULT_LIST_LIMIT);
      const documents = await input.dependencies.listDocuments(ctx, {
        ...(folder ? { folder: normalizeGoatBrainFolderForV1(folder) } : {}),
        ...(type ? { type } : {}),
        ...(kind ? { kind } : {}),
        limit,
        ...(booleanFlag(flags["include-merged"]) ? { includeMerged: true } : {}),
      });
      return { documents };
    }
  }
}

const ALLOWED_FLAGS: Record<GoatBrainRetrievalCommand, ReadonlySet<string>> = {
  query: new Set([
    "text",
    "folder",
    "type",
    "kind",
    "since",
    "limit",
    "offset",
    "hops",
    "include-neighbors",
    "snippet-chars",
    "lexical-only",
    "include-merged",
    "include-archived",
  ]),
  get: new Set(["id"]),
  timeline: new Set(["id", "limit", "since"]),
  list: new Set(["folder", "type", "kind", "limit", "include-merged"]),
};

function validateFlags(
  command: GoatBrainRetrievalCommand,
  flags: Record<string, GoatBrainToolFlagValue>,
) {
  const unknown = Object.keys(flags).find((flag) => !ALLOWED_FLAGS[command].has(flag));
  if (unknown) throw new Error(`Unsupported goat_brain flag "--${unknown}" for ${command}.`);
}

function normalizeFlags(input: Record<string, GoatBrainToolFlagValue>) {
  return Object.fromEntries(
    Object.entries(input).map(([rawName, value]) => [
      rawName
        .trim()
        .replace(/_/g, "-")
        .replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
        .replace(/^-+/, "")
        .replace(/-+/g, "-"),
      value,
    ]),
  );
}

function flagString(value: GoatBrainToolFlagValue | undefined) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

function flagStringList(value: GoatBrainToolFlagValue | undefined) {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  const single = flagString(value);
  return single ? [single] : [];
}

function numberFlag(value: GoatBrainToolFlagValue | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function integerFlag(
  value: GoatBrainToolFlagValue | undefined,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const parsed = value === undefined ? fallback : numberFlag(value);
  if (
    parsed === undefined ||
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function booleanFlag(value: GoatBrainToolFlagValue | undefined) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && value.trim().toLowerCase() === "true") return true;
  if (typeof value === "string" && value.trim().toLowerCase() === "false") return false;
  return undefined;
}

function entityTypeFlag(value: GoatBrainToolFlagValue | undefined) {
  const type = flagString(value);
  if (!type) return undefined;
  if (!isBuiltInGoatBrainEntityType(type)) {
    throw new Error(
      `Unsupported Goat Brain entity type "${type}". Use one of: ${GOAT_BRAIN_ENTITY_TYPES.join(", ")}.`,
    );
  }
  return type;
}

function kindFlag(value: GoatBrainToolFlagValue | undefined) {
  const kind = flagString(value);
  if (!kind) return undefined;
  if (!isValidGoatBrainKind(kind)) throw new Error('kind must be "page" or "evidence".');
  return kind;
}

async function recordBrainToolRun(input: {
  db: any;
  traceId: string;
  startedAt: Date;
  context: GoatCodexBrainToolContext;
  call: CodexAppServerDynamicToolCall;
  toolInput: GoatBrainReadToolInput | null;
  output: GoatCodexBrainToolOutput;
}) {
  try {
    await input.db.insert(goatBrainToolRuns).values({
      id: input.traceId,
      brainRef: input.context.brainRef,
      userWorkosId: input.context.userWorkosId,
      chatSessionId: input.context.chatSessionId,
      userMessageId: input.context.userMessageId,
      assistantMessageId: input.context.assistantMessageId,
      toolCallId: input.call.callId,
      sourceRef: `codex-chat:${input.context.userMessageId}`,
      action: input.output.command ?? null,
      ok: input.output.ok,
      exitCode: input.output.exitCode,
      durationMs: input.output.durationMs,
      tracePath: null,
      trace: {
        schemaVersion: "goat.brain.codex-read.v1",
        startedAt: input.startedAt.toISOString(),
        threadId: input.call.threadId,
        turnId: input.call.turnId,
        toolInput: input.toolInput,
        output: {
          ok: input.output.ok,
          error: input.output.error,
        },
      },
    });
  } catch (error) {
    logger.warn("Failed to persist Codex Brain tool run", {
      event: "opencompany.goat_codex_brain_tool_audit_failed",
      trace_id: input.traceId,
      error,
    });
  }
}
