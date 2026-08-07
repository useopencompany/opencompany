import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GOAT_BRAIN_ENTITY_TYPES,
  type GoatBrainKind,
  isBuiltInGoatBrainEntityType,
  isValidGoatBrainKind,
  normalizeGoatBrainFolderForV1,
} from "@opencompany/brain";
import { getGoatBrainCliSource } from "@opencompany/brain/cli-bundle";
import {
  type MaterializedGoatBrainFile,
  materializeGoatBrainFilesToRoot,
  syncGoatBrainFilesFromRoot,
} from "@opencompany/db/brain-files";
import {
  type GoatBrainDocumentRead,
  type GoatBrainReadContext,
  type GoatBrainSearchHit,
  getGoatBrainDocuments,
  getGoatBrainTimeline,
  listGoatBrainDocuments,
  searchGoatBrain,
} from "@opencompany/db/brain-read";
import { getDb } from "@opencompany/db/client";
import { createPooledDb } from "@opencompany/db/pool";
import { goatBrainToolRuns, goatUsers } from "@opencompany/db/schema";
import { createGoatGatewayAttribution } from "@opencompany/telemetry";
import { and, eq, isNull } from "drizzle-orm";
import { GOAT_BRAIN_READ_PLANE_COMMANDS } from "@/lib/brain-surface";
import type {
  GoatBrainCliCommand,
  GoatBrainToolFlagValue,
  GoatBrainToolInput,
  GoatBrainToolOutput,
} from "@/lib/chat-ui";
import { isGoatMcpSetupCompletionRun } from "@/lib/mcp-setup";

const GOAT_BRAIN_CHAT_CLI_TIMEOUT_MS = 60_000;
const GOAT_BRAIN_TRACE_SCHEMA_VERSION = "goat.brain.cli-run.v2";
const DEFAULT_GOAT_BRAIN_QUERY_LIMIT = 10;
const MAX_GOAT_BRAIN_QUERY_LIMIT = 50;
const GOAT_BRAIN_TOOL_HELP =
  'Use goat_brain as { command, flags, stdin? }. For command-specific usage, call { command: "help", flags: { topic: "<command>" } }. Common commands: list, query, get, create, append-evidence, timeline-add, rewrite, alias, link, merge, move, delete, folder, doctor. The brain has required folders inbox, skills, people, companies, and evidence; core folders such as thoughts, projects, meetings, research, decisions, and concepts are adjustable and can be recreated with folder create when needed. Skills are excluded from default list/query retrieval; pass folder: "skills" (or a descendant) to retrieve them explicitly, while get remains available by id. query returns curated pages by default; pass kind: "evidence" only when raw evidence is explicitly needed. query supports type/kind/folder filters, hops for graph expansion, and offset pagination; when pagination.hasMore is true, repeat the same query with offset set to pagination.nextOffset. Hits list linked pages — follow them with get. get accepts one id or a list of ids (aliases resolve too). Use append-evidence to create sourced evidence records linked to a subject. Use includeMerged when you need merged records and includeArchived when you need archived ones.';

const READ_ONLY_GOAT_BRAIN_COMMANDS = new Set<GoatBrainCliCommand>([
  "help",
  "list",
  "get",
  "timeline",
  "query",
  "doctor",
  "folder",
]);
// Commands served by the DB read plane (@opencompany/db/brain-read) — indexed SQL, no brain
// materialization, no CLI spawn. `help`/`folder`/`doctor` stay on the CLI: help is static text and
// doctor legitimately wants the full corpus.
const READ_PLANE_GOAT_BRAIN_COMMANDS = new Set<GoatBrainCliCommand>(GOAT_BRAIN_READ_PLANE_COMMANDS);
const GOAT_BRAIN_MUTATION_QUEUES = new Map<string, Promise<void>>();

type GoatBrainCliTraceContext = {
  sourceRef: string;
  toolInput: GoatBrainToolInput;
  chatSessionId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  toolCallId?: string;
};

type ResolvedGoatBrainCliArgs = {
  argv: string[];
  display: string;
};

type GoatBrainCliProcessResult = GoatBrainToolOutput & {
  rawStdout: string;
  rawStderr: string;
  timedOut?: boolean;
  aborted?: boolean;
};

export async function runGoatBrainCliForUser(input: {
  brainRef: string;
  userWorkosId: string;
  args?: string;
  argv?: string[];
  gatewayApiKey: string;
  stdin?: string;
  trace?: GoatBrainCliTraceContext;
  signal?: AbortSignal;
}): Promise<GoatBrainToolOutput> {
  const resolved = resolveGoatBrainCliArgs(input);
  if (!resolved) {
    return {
      ok: false,
      brainRef: input.brainRef,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: "goat_brain args are required.",
    };
  }

  const command = normalizeResolvedGoatBrainCommand(resolved.argv[0]);
  if (command && !goatBrainCommandIsReadOnly(command)) {
    // Queue keyed by brain: shared brains serialize mutations across users.
    return enqueueGoatBrainMutation(input.brainRef, () =>
      runResolvedGoatBrainCliForUser(input, resolved, command),
    );
  }
  return runResolvedGoatBrainCliForUser(input, resolved, command);
}

export async function runGoatBrainToolForUser(input: {
  brainRef: string;
  userWorkosId: string;
  toolInput: GoatBrainToolInput;
  gatewayApiKey: string;
  sourceRef: string;
  chatSessionId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
}): Promise<GoatBrainToolOutput> {
  let invocation: { argv: string[]; stdin?: string };
  try {
    invocation = goatBrainToolInvocation(input.toolInput, input.sourceRef);
  } catch (error) {
    return {
      ok: false,
      brainRef: input.brainRef,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: errorMessage(error),
    };
  }
  if (READ_PLANE_GOAT_BRAIN_COMMANDS.has(input.toolInput.command)) {
    return runGoatBrainReadCommandForUser(input, {
      argv: invocation.argv,
      display: formatCliDisplay(invocation.argv),
    });
  }
  return runGoatBrainCliForUser({
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    argv: invocation.argv,
    gatewayApiKey: input.gatewayApiKey,
    ...(invocation.stdin ? { stdin: invocation.stdin } : {}),
    trace: {
      sourceRef: input.sourceRef,
      toolInput: input.toolInput,
      ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

async function runResolvedGoatBrainCliForUser(
  input: {
    brainRef: string;
    userWorkosId: string;
    gatewayApiKey: string;
    stdin?: string;
    trace?: GoatBrainCliTraceContext;
    signal?: AbortSignal;
  },
  resolved: ResolvedGoatBrainCliArgs,
  command: GoatBrainCliCommand | null,
): Promise<GoatBrainToolOutput> {
  const shouldSync = Boolean(command && !goatBrainCommandIsReadOnly(command));
  const root = await mkdtemp(path.join(os.tmpdir(), "goat-chat-brain-"));
  const startedAt = new Date();
  const startedAtMs = Date.now();
  const traceId = `goat_brain_run_${randomUUID()}`;
  let materialized: MaterializedGoatBrainFile[] = [];
  let processResult: GoatBrainCliProcessResult | null = null;
  let syncResult: { ok: true } | { ok: false; error: string } | null = null;
  let output: GoatBrainToolOutput;

  try {
    materialized = await materializeGoatBrainFilesToRoot({
      brainRef: input.brainRef,
      root,
      cliSource: getGoatBrainCliSource(),
    });
    processResult = await runCliProcess({
      cliPath: path.join(root, "goat-brain.mjs"),
      argv: resolved.argv,
      root,
      gatewayApiKey: input.gatewayApiKey,
      reporting: createGoatGatewayAttribution({
        userWorkosId: input.userWorkosId,
        feature: "brain-query",
        brainRef: input.brainRef,
        ...(input.trace?.chatSessionId ? { chatSessionId: input.trace.chatSessionId } : {}),
      }),
      ...(input.stdin ? { stdin: input.stdin } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

    output = publicGoatBrainCliOutput(processResult, resolved);
    if (shouldSync && processResult.ok) {
      const synced = await syncGoatBrainFilesFromRootWithTransactionDb({
        brainRef: input.brainRef,
        userWorkosId: input.userWorkosId,
        root,
        baseSnapshot: materialized,
      });
      if (synced.conflicts.length > 0) {
        syncResult = {
          ok: false,
          error: `Brain changed while the tool was running. Retry before writing ${synced.conflicts
            .map((conflict) => conflict.path)
            .join(", ")}.`,
        };
        output = {
          ...output,
          ok: false,
          error: syncResult.error,
        };
      } else {
        syncResult = { ok: true };
      }
    }
  } catch (error) {
    output = {
      ok: false,
      exitCode: processResult?.exitCode ?? null,
      stdout: processResult?.stdout ?? "",
      stderr: processResult?.stderr ?? "",
      command: resolved.display,
      argv: resolved.argv,
      error: errorMessage(error),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const durationMs = Date.now() - startedAtMs;
  output = {
    ...output,
    brainRef: input.brainRef,
    traceId,
    durationMs,
  };
  await recordGoatBrainToolRun({
    traceId,
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    command,
    resolved,
    startedAt,
    durationMs,
    materialized,
    processResult,
    output,
    traceContext: input.trace ?? null,
    syncResult,
  });
  return output;
}

// --- read plane -------------------------------------------------------------------------------
// query/get/timeline/list are served in-process by @opencompany/db/brain-read instead of
// materializing the brain and spawning the CLI. Read results expose the machine-readable `parsed`
// payload only; returning the equivalent human rendering as `stdout` would duplicate every result
// in the model context. Every run is still traced.

async function runGoatBrainReadCommandForUser(
  input: {
    brainRef: string;
    userWorkosId: string;
    toolInput: GoatBrainToolInput;
    gatewayApiKey: string;
    sourceRef: string;
    chatSessionId?: string;
    userMessageId?: string;
    assistantMessageId?: string;
    toolCallId?: string;
  },
  resolved: ResolvedGoatBrainCliArgs,
): Promise<GoatBrainToolOutput> {
  const startedAt = new Date();
  const startedAtMs = Date.now();
  const traceId = `goat_brain_run_${randomUUID()}`;
  const ctx: GoatBrainReadContext = {
    brainRef: input.brainRef,
    gatewayApiKey: input.gatewayApiKey,
    reporting: createGoatGatewayAttribution({
      userWorkosId: input.userWorkosId,
      feature: "brain-query",
      brainRef: input.brainRef,
      ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
    }),
  };
  const flags = normalizeCliToolFlags(input.toolInput.flags ?? {});

  let output: GoatBrainToolOutput;
  try {
    const result = await executeGoatBrainReadCommand(ctx, input.toolInput.command, flags);
    output = {
      ok: true,
      exitCode: 0,
      stderr: "",
      command: resolved.display,
      argv: resolved.argv,
      parsed: result.parsed,
    };
  } catch (error) {
    output = {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      command: resolved.display,
      argv: resolved.argv,
      // Read errors return just the message: GOAT_BRAIN_TOOL_HELP documents write commands
      // (create/rewrite/merge/delete…) the read surface cannot call, so appending it here misleads.
      error: errorMessage(error),
    };
  }

  const durationMs = Date.now() - startedAtMs;
  output = { ...output, brainRef: input.brainRef, traceId, durationMs };
  await recordGoatBrainToolRun({
    traceId,
    brainRef: input.brainRef,
    userWorkosId: input.userWorkosId,
    command: input.toolInput.command,
    resolved,
    startedAt,
    durationMs,
    materialized: [],
    processResult: null,
    output,
    traceContext: {
      sourceRef: input.sourceRef,
      toolInput: input.toolInput,
      ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    },
    syncResult: null,
  });
  return output;
}

async function executeGoatBrainReadCommand(
  ctx: GoatBrainReadContext,
  command: GoatBrainCliCommand,
  flags: Record<string, GoatBrainToolFlagValue>,
): Promise<{ stdout: string; parsed: unknown }> {
  switch (command) {
    case "query": {
      const folder = flagString(flags.folder);
      const type = readEntityTypeFlag(flags.type);
      const kind = readKindFlag(flags.kind) ?? "page";
      const since = flagString(flags.since);
      const limit = readQueryLimit(flags.limit);
      const offset = readQueryOffset(flags.offset);
      const hops = flagNumber(flags.hops);
      const includeNeighbors = flagBoolean(flags["include-neighbors"]);
      const snippetChars = flagNumber(flags["snippet-chars"]);
      const text = flagString(flags.text) ?? "";
      const candidates = await searchGoatBrain(ctx, {
        text,
        ...(folder ? { folder: normalizeGoatBrainFolderForV1(folder) } : {}),
        ...(type ? { type } : {}),
        kind: kind as GoatBrainKind,
        ...(since ? { since } : {}),
        limit: limit + 1,
        offset,
        ...(hops !== undefined ? { hops: Math.max(0, hops) } : {}),
        ...(includeNeighbors !== undefined ? { includeNeighbors } : {}),
        ...(snippetChars !== undefined ? { snippetChars } : {}),
        ...(flagBoolean(flags["lexical-only"]) ? { lexicalOnly: true } : {}),
        ...(flagBoolean(flags["include-merged"]) ? { includeMerged: true } : {}),
        ...(flagBoolean(flags["include-archived"]) ? { includeArchived: true } : {}),
        ...(flagBoolean(flags["include-conflicts"]) ? { includeConflicts: true } : {}),
      });
      const hasMore = candidates.length > limit;
      const hits = candidates.slice(0, limit);
      const pagination = queryPagination({ limit, offset, returned: hits.length, hasMore });
      // `mode` distinguishes a relevance-ranked search from a recency-ordered browse (no query),
      // where score reflects freshness only.
      return {
        stdout: renderQueryHits(hits, pagination),
        parsed: {
          hits,
          mode: text ? "search" : "browse",
          scope: { kind },
          pagination,
        },
      };
    }
    case "get": {
      const ids = flagStringList(flags.id);
      if (ids.length === 0) throw new Error("goat_brain get requires an id (or a list of ids).");
      const section = flagString(flags.section) ?? "all";
      if (!["all", "frontmatter", "truth", "timeline"].includes(section)) {
        throw new Error("`section` must be all, frontmatter, truth, or timeline.");
      }
      const result = await getGoatBrainDocuments(ctx, ids);
      if (result.documents.length === 0) {
        throw new Error(
          `No brain doc found with id ${ids.map((id) => `"${id}"`).join(", ")}. Search for it to find the right id.`,
        );
      }
      return {
        stdout: renderDocuments(result.documents, result.missing, section),
        parsed: result,
      };
    }
    case "timeline": {
      const id = flagString(flags.id);
      if (!id) throw new Error("goat_brain timeline requires an id.");
      const since = flagString(flags.since);
      const limit = flagNumber(flags.limit);
      const result = await getGoatBrainTimeline(ctx, id, {
        ...(since ? { since } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (!result)
        throw new Error(`No brain doc found with id "${id}". Search for it to find the right id.`);
      const stdout = result.entries.length
        ? result.entries
            .map((entry) =>
              [
                `### ${entry.at}`,
                entry.summary,
                entry.detail,
                entry.sourceRef
                  ? `Source: ${entry.sourceTitle ? `${entry.sourceTitle} (${entry.sourceRef})` : entry.sourceRef}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            )
            .join("\n\n")
        : "_No timeline yet._";
      return { stdout, parsed: result };
    }
    case "list": {
      const folder = flagString(flags.folder);
      const type = readEntityTypeFlag(flags.type);
      const kind = readKindFlag(flags.kind);
      const limit = flagNumber(flags.limit);
      const documents = await listGoatBrainDocuments(ctx, {
        ...(folder ? { folder: normalizeGoatBrainFolderForV1(folder) } : {}),
        ...(type ? { type } : {}),
        ...(kind ? { kind: kind as GoatBrainKind } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(flagBoolean(flags["include-merged"]) ? { includeMerged: true } : {}),
        ...(flagBoolean(flags["include-conflicts"]) ? { includeConflicts: true } : {}),
      });
      const stdout = documents.length
        ? documents
            .map(
              (doc) =>
                `[${doc.folder}] ${doc.title} (${doc.id}, ${doc.type}, ${doc.status}, updated ${doc.updatedAt})`,
            )
            .join("\n")
        : "_No brain docs found._";
      return { stdout, parsed: { documents } };
    }
    default:
      throw new Error(`Unsupported read command "${command}".`);
  }
}

type GoatBrainQueryPagination = {
  limit: number;
  offset: number;
  returned: number;
  hasMore: boolean;
  nextOffset?: number;
  instruction?: string;
};

function queryPagination(input: {
  limit: number;
  offset: number;
  returned: number;
  hasMore: boolean;
}): GoatBrainQueryPagination {
  if (!input.hasMore) return input;
  const nextOffset = input.offset + input.returned;
  return {
    ...input,
    nextOffset,
    instruction: `More matches are available. Repeat the same query with all filters unchanged and offset set to ${nextOffset}.`,
  };
}

function renderQueryHits(hits: GoatBrainSearchHit[], pagination: GoatBrainQueryPagination): string {
  const renderedHits = hits.length
    ? hits
        .map((hit, index) => {
          const neighbors = hit.neighbors
            .map(
              (link) =>
                `${link.direction === "out" ? "→" : "←"} ${link.relationType} ${link.id} (${link.title}, ${link.kind}/${link.type})`,
            )
            .join(", ");
          return [
            `${pagination.offset + index + 1}. [${hit.folder}] ${hit.title} (${hit.id}, ${hit.type}, score ${hit.score}, updated ${hit.updatedAt})`,
            hit.snippet,
            neighbors ? `Linked: ${neighbors}` : "",
            `Next: get ${hit.id}`,
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n\n")
    : "No matches.";
  return [renderedHits, pagination.instruction].filter(Boolean).join("\n\n");
}

function renderDocuments(
  documents: GoatBrainDocumentRead[],
  missing: string[],
  section: string,
): string {
  const parts = documents.map((doc) => renderDocument(doc, section));
  if (missing.length > 0) {
    parts.push(`Not found: ${missing.join(", ")}. Try query to locate them.`);
  }
  return parts.join("\n\n---\n\n");
}

function renderDocument(doc: GoatBrainDocumentRead, section: string): string {
  if (section === "truth") return doc.compiledTruth || "_No compiled truth yet._";
  if (section === "frontmatter") {
    return JSON.stringify(
      {
        requestedId: doc.requestedId,
        id: doc.id,
        resolvedVia: doc.resolvedVia,
        title: doc.title,
        folder: doc.folder,
        kind: doc.kind,
        type: doc.type,
        format: doc.format,
        status: doc.status,
        aliases: doc.aliases,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        sources: doc.sources,
      },
      null,
      2,
    );
  }
  const timeline = doc.timeline.length
    ? doc.timeline.map((entry) => `### ${entry.at}\n${entry.body}`).join("\n\n")
    : "_No timeline yet._";
  if (section === "timeline") return timeline;

  const resolvedNote =
    doc.resolvedVia === "id" ? "" : ` (resolved from "${doc.requestedId}" via ${doc.resolvedVia})`;
  const links = doc.links.length
    ? doc.links
        .map(
          (link) =>
            `- ${link.direction === "out" ? "→" : "←"} ${link.relationType} ${link.id} (${link.title}, ${link.kind}/${link.type})`,
        )
        .join("\n")
    : "_No links._";
  const timelineHeading =
    doc.timelineTotal > doc.timeline.length
      ? `## Timeline (last ${doc.timeline.length} of ${doc.timelineTotal}; use timeline for more)`
      : "## Timeline";
  return [
    `# ${doc.title} (${doc.id})${resolvedNote}`,
    `folder: ${doc.folder} | kind: ${doc.kind} | type: ${doc.type} | format: ${doc.format} | status: ${doc.status} | updated: ${doc.updatedAt}`,
    doc.aliases.length ? `aliases: ${doc.aliases.join(", ")}` : "",
    "## Compiled truth",
    doc.compiledTruth || "_No compiled truth yet._",
    ...(doc.assetText
      ? ["## Extracted text (machine-generated from the asset)", doc.assetText]
      : []),
    timelineHeading,
    timeline,
    "## Links",
    links,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function flagString(value: GoatBrainToolFlagValue | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

function flagStringList(value: GoatBrainToolFlagValue | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  const single = flagString(value);
  return single ? [single] : [];
}

function flagNumber(value: GoatBrainToolFlagValue | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readQueryLimit(value: GoatBrainToolFlagValue | undefined): number {
  const parsed = flagNumber(value);
  const limit = parsed ?? DEFAULT_GOAT_BRAIN_QUERY_LIMIT;
  if (
    (value !== undefined && parsed === undefined) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_GOAT_BRAIN_QUERY_LIMIT
  ) {
    throw new Error(`limit must be an integer from 1 to ${MAX_GOAT_BRAIN_QUERY_LIMIT}.`);
  }
  return limit;
}

function readQueryOffset(value: GoatBrainToolFlagValue | undefined): number {
  const parsed = flagNumber(value);
  const offset = parsed ?? 0;
  if (
    (value !== undefined && parsed === undefined) ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw new Error("offset must be a non-negative integer.");
  }
  return offset;
}

function flagBoolean(value: GoatBrainToolFlagValue | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.trim().toLowerCase() === "true") return true;
    if (value.trim().toLowerCase() === "false") return false;
  }
  return undefined;
}

function readEntityTypeFlag(value: GoatBrainToolFlagValue | undefined): string | undefined {
  const type = flagString(value);
  if (!type) return undefined;
  if (!isBuiltInGoatBrainEntityType(type)) {
    throw new Error(
      `Unsupported Goat Brain entity type "${type}". Use one of: ${GOAT_BRAIN_ENTITY_TYPES.join(", ")}.`,
    );
  }
  return type;
}

function readKindFlag(value: GoatBrainToolFlagValue | undefined): string | undefined {
  const kind = flagString(value);
  if (!kind) return undefined;
  if (!isValidGoatBrainKind(kind)) {
    throw new Error('kind must be "page" or "evidence".');
  }
  return kind;
}

async function syncGoatBrainFilesFromRootWithTransactionDb(input: {
  brainRef: string;
  userWorkosId: string;
  root: string;
  baseSnapshot: MaterializedGoatBrainFile[];
}) {
  const pooled = createPooledDb(undefined, { max: 1 });
  try {
    return await syncGoatBrainFilesFromRoot({
      ...input,
      db: pooled.db,
    });
  } finally {
    await pooled.close();
  }
}

function goatBrainToolInvocation(
  input: GoatBrainToolInput,
  sourceRef: string,
): { argv: string[]; stdin?: string } {
  const rendered = renderGoatBrainToolCommand(input, sourceRef);
  return {
    argv: rendered.argv,
    ...(rendered.stdin ? { stdin: rendered.stdin } : {}),
  };
}

const GOAT_BRAIN_TOOL_COMMAND_FLAGS: Record<GoatBrainCliCommand, readonly string[]> = {
  help: ["topic", "command", "json"],
  create: [
    "folder",
    "id",
    "title",
    "type",
    "kind",
    "truth",
    "truth-stdin",
    "alias",
    "relation",
    "source-ref",
    "source-title",
    "evidence-id",
    "status",
    "json",
  ],
  list: ["folder", "type", "kind", "limit", "include-merged", "include-conflicts", "json"],
  get: ["id", "section", "json"],
  query: [
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
    // Accepted for compatibility with existing model habits; the read plane ignores them
    // (expansion is always both-direction, and stored documents are valid by construction).
    "graph-direction",
    "lexical-only",
    "include-invalid",
    "include-merged",
    "include-archived",
    "include-conflicts",
    "json",
  ],
  timeline: ["id", "limit", "since", "json"],
  rewrite: ["id", "truth", "truth-stdin", "json"],
  set: ["id", "title", "type", "status", "json"],
  "timeline-add": [
    "id",
    "at",
    "body",
    "body-stdin",
    "detail",
    "detail-stdin",
    "source-ref",
    "source-title",
    "evidence-id",
    "json",
  ],
  "append-timeline": [
    "id",
    "at",
    "body",
    "body-stdin",
    "detail",
    "detail-stdin",
    "source-ref",
    "source-title",
    "evidence-id",
    "json",
  ],
  "append-evidence": [
    "id",
    "type",
    "folder",
    "at",
    "title",
    "body",
    "body-stdin",
    "detail",
    "detail-stdin",
    "source-ref",
    "source-title",
    "evidence-id",
    "relation",
    "json",
  ],
  alias: ["id", "add", "remove", "json"],
  link: ["id", "to", "as", "remove", "json"],
  merge: ["from", "into", "json"],
  move: ["id", "folder", "json"],
  delete: ["id", "force", "dry-run", "json"],
  folder: ["subcommand", "path", "from", "to", "json"],
  doctor: ["json"],
};

export function renderGoatBrainToolCommand(
  input: GoatBrainToolInput,
  sourceRef: string,
): { argv: string[]; stdin?: string } {
  const allowed = GOAT_BRAIN_TOOL_COMMAND_FLAGS[input.command];
  if (!allowed) throw goatBrainToolInputError(`Unsupported goat_brain command "${input.command}".`);

  const flags = normalizeCliToolFlags(input.flags ?? {});
  applyImplicitStdinFlags(input.command, flags, input.stdin);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(flags).find((name) => !allowedSet.has(name));
  if (unknown) {
    throw goatBrainToolInputError(
      `Unsupported goat_brain flag "--${unknown}" for command "${input.command}".`,
      input.command,
    );
  }

  if (input.command === "delete" && flags.force === true) {
    throw goatBrainToolInputError("The chat tool may only preview deletes. Use dryRun: true.", [
      "delete",
    ]);
  }
  if (input.command === "create") validateCreateFlags(flags, input.stdin);

  const command = cliCommandForToolCommand(input.command);
  const argv: string[] = [command];
  if (input.command === "help") {
    const topic = flags.topic ?? flags.command;
    if (typeof topic === "string" && topic.trim()) argv.push(topic.trim());
    delete flags.topic;
    delete flags.command;
  }
  if (input.command === "folder") {
    const subcommand = flags.subcommand;
    if (typeof subcommand === "string" && subcommand.trim()) argv.push(subcommand.trim());
    delete flags.subcommand;
  }
  if (input.command === "delete") flags["dry-run"] = true;

  injectGoatBrainSourceRef(input.command, flags, sourceRef);
  for (const [name, value] of Object.entries(flags)) {
    if (name === "force") continue;
    appendCliFlag(argv, name, value);
  }
  return { argv, ...(input.stdin ? { stdin: input.stdin } : {}) };
}

function cliCommandForToolCommand(command: GoatBrainCliCommand): string {
  return command;
}

function applyImplicitStdinFlags(
  command: GoatBrainCliCommand,
  flags: Record<string, GoatBrainToolFlagValue>,
  stdin: string | undefined,
) {
  if (!stdin?.trim()) return;
  if (command === "create" && flags.truth === undefined && flags["truth-stdin"] === undefined) {
    flags["truth-stdin"] = true;
    return;
  }
  if (command === "rewrite" && flags.truth === undefined && flags["truth-stdin"] === undefined) {
    flags["truth-stdin"] = true;
    return;
  }
  if (
    (command === "timeline-add" ||
      command === "append-timeline" ||
      command === "append-evidence") &&
    flags.body === undefined &&
    flags["body-stdin"] === undefined
  ) {
    flags["body-stdin"] = true;
  }
}

function normalizeCliToolFlags(input: Record<string, GoatBrainToolFlagValue>) {
  const out: Record<string, GoatBrainToolFlagValue> = {};
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName
      .trim()
      .replace(/_/g, "-")
      .replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)
      .replace(/^-+/, "")
      .replace(/-+/g, "-");
    if (name) out[name] = value;
  }
  return out;
}

function injectGoatBrainSourceRef(
  command: GoatBrainCliCommand,
  flags: Record<string, GoatBrainToolFlagValue>,
  sourceRef: string,
) {
  if (
    command === "create" ||
    command === "timeline-add" ||
    command === "append-timeline" ||
    command === "append-evidence"
  ) {
    flags["source-ref"] = sourceRef;
  }
}

function validateCreateFlags(
  flags: Record<string, GoatBrainToolFlagValue>,
  stdin: string | undefined,
) {
  const type = typeof flags.type === "string" ? flags.type.trim() : "";
  if (!type) {
    throw goatBrainToolInputError(
      `goat_brain create requires a type. Use one of: ${GOAT_BRAIN_ENTITY_TYPES.join(", ")}.`,
      "create",
    );
  }
  if (!isBuiltInGoatBrainEntityType(type)) {
    throw goatBrainToolInputError(
      `Unsupported Goat Brain entity type "${type}". Use one of: ${GOAT_BRAIN_ENTITY_TYPES.join(
        ", ",
      )}.`,
      "create",
    );
  }
  const hasTruth =
    (typeof flags.truth === "string" && flags.truth.trim().length > 0) ||
    (flags["truth-stdin"] === true && Boolean(stdin?.trim()));
  if (!hasTruth) {
    throw goatBrainToolInputError(
      "goat_brain create requires compiled truth via truth or non-empty truthStdin.",
      "create",
    );
  }
  const kind = typeof flags.kind === "string" ? flags.kind.trim() : "";
  if (kind && !isValidGoatBrainKind(kind)) {
    throw goatBrainToolInputError(
      'goat_brain create kind must be "page" or "evidence". Evidence documents live under the "evidence/" folder zone; folders are otherwise free-form.',
      "create",
    );
  }
}

function goatBrainToolInputError(message: string, command?: GoatBrainCliCommand | string[]) {
  const topics =
    typeof command === "string" ? [command] : Array.isArray(command) ? command : undefined;
  const topicHelp = topics?.length
    ? `\n\nRelevant help command: { command: "help", flags: { topic: "${topics[0]}" } }.`
    : "";
  return new Error(`${message}\n\n${GOAT_BRAIN_TOOL_HELP}${topicHelp}`);
}

function appendCliFlag(argv: string[], name: string, value: GoatBrainToolFlagValue) {
  if (typeof value === "boolean") {
    if (value) argv.push(`--${name}`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) argv.push(`--${name}`, item);
    return;
  }
  argv.push(`--${name}`, String(value));
}

function resolveGoatBrainCliArgs(input: { args?: string; argv?: string[] }) {
  if (input.argv) {
    const argv = input.argv.map((item) => item.trim()).filter(Boolean);
    return argv.length > 0 ? { argv, display: formatCliDisplay(argv) } : null;
  }
  const rawArgs = input.args?.trim();
  if (!rawArgs) return null;
  const argv = splitCliArgs(rawArgs);
  return argv.length > 0 ? { argv, display: rawArgs } : null;
}

function normalizeResolvedGoatBrainCommand(value: string | undefined): GoatBrainCliCommand | null {
  return isGoatBrainCliCommand(value) ? value : null;
}

function isGoatBrainCliCommand(value: unknown): value is GoatBrainCliCommand {
  return (
    typeof value === "string" &&
    Object.hasOwn(GOAT_BRAIN_TOOL_COMMAND_FLAGS, value as GoatBrainCliCommand)
  );
}

function goatBrainCommandIsReadOnly(command: GoatBrainCliCommand): boolean {
  return READ_ONLY_GOAT_BRAIN_COMMANDS.has(command);
}

async function enqueueGoatBrainMutation<T>(brainRef: string, run: () => Promise<T>): Promise<T> {
  const previous = GOAT_BRAIN_MUTATION_QUEUES.get(brainRef) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = previous.then(run, run);
  const parked = current.then(
    () => new Promise<void>((resolve) => (release = resolve)),
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  GOAT_BRAIN_MUTATION_QUEUES.set(brainRef, parked);
  try {
    return await current;
  } finally {
    release();
    if (GOAT_BRAIN_MUTATION_QUEUES.get(brainRef) === parked) {
      GOAT_BRAIN_MUTATION_QUEUES.delete(brainRef);
    }
  }
}

async function runCliProcess(input: {
  cliPath: string;
  argv: string[];
  root: string;
  gatewayApiKey: string;
  reporting?: { user?: string; tags: string[] };
  stdin?: string;
  signal?: AbortSignal;
}): Promise<GoatBrainCliProcessResult> {
  const child = spawn(process.execPath, [input.cliPath, ...input.argv, "--report-usage"], {
    env: childBrainCliEnv(input),
    stdio: [input.stdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (input.stdin && child.stdin) {
    child.stdin.on("error", () => {
      // Child processes may exit before consuming stdin. The exit path below reports the command
      // result; an EPIPE from this write should not crash the parent process.
    });
    child.stdin.end(input.stdin);
  }

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abort);
      child.kill("SIGTERM");
      resolve({
        ok: false,
        exitCode: null,
        stdout: cleanCliStdout(stdout),
        stderr: truncate(stderr, 20_000),
        error: "goat_brain timed out.",
        rawStdout: stdout,
        rawStderr: stderr,
        timedOut: true,
      });
    }, GOAT_BRAIN_CHAT_CLI_TIMEOUT_MS);

    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      resolve({
        ok: false,
        exitCode: null,
        stdout: cleanCliStdout(stdout),
        stderr: truncate(stderr, 20_000),
        error: "goat_brain was aborted.",
        rawStdout: stdout,
        rawStderr: stderr,
        aborted: true,
      });
    };
    input.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      resolve({
        ok: false,
        exitCode: null,
        stdout: cleanCliStdout(stdout),
        stderr: truncate(stderr, 20_000),
        error: error.message,
        rawStdout: stdout,
        rawStderr: stderr,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout: cleanCliStdout(stdout),
        stderr: truncate(stderr, 20_000),
        ...(code === 0 ? {} : { error: "goat_brain failed." }),
        rawStdout: stdout,
        rawStderr: stderr,
      });
    });
  });
}

function childBrainCliEnv(input: {
  root: string;
  gatewayApiKey: string;
  reporting?: { user?: string; tags: string[] };
}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "production",
    GOAT_BRAIN_ROOT: input.root,
    VERCEL_AI_GATEWAY_API_KEY: input.gatewayApiKey,
    ...(process.env.GOAT_BRAIN_GATEWAY_BASE_URL
      ? { GOAT_BRAIN_GATEWAY_BASE_URL: process.env.GOAT_BRAIN_GATEWAY_BASE_URL }
      : {}),
    ...(process.env.GOAT_BRAIN_EMBEDDING_MODEL
      ? { GOAT_BRAIN_EMBEDDING_MODEL: process.env.GOAT_BRAIN_EMBEDDING_MODEL }
      : {}),
    ...(input.reporting?.user ? { GOAT_GATEWAY_REPORTING_USER: input.reporting.user } : {}),
    ...(input.reporting?.tags.length
      ? { GOAT_GATEWAY_REPORTING_TAGS: input.reporting.tags.join(",") }
      : {}),
  };
}

function publicGoatBrainCliOutput(
  result: GoatBrainCliProcessResult,
  resolved: ResolvedGoatBrainCliArgs,
): GoatBrainToolOutput {
  const stdout = cleanCliStdout(result.rawStdout);
  const stderr = truncate(result.rawStderr, 20_000);
  const parsed = parseCliJson(stdout);
  const parsedError = readParsedCliError(parsed);
  const error = result.error
    ? !result.ok && stderr.trim()
      ? stderr.trim()
      : (parsedError ?? result.error)
    : undefined;
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    stderr,
    command: resolved.display,
    argv: resolved.argv,
    ...(parsed !== null ? { parsed } : { stdout }),
    ...(error ? { error } : {}),
  };
}

function readParsedCliError(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const error = (parsed as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error.trim() : null;
}

async function recordGoatBrainToolRun(input: {
  traceId: string;
  brainRef: string;
  userWorkosId: string;
  command: GoatBrainCliCommand | null;
  resolved: ResolvedGoatBrainCliArgs;
  startedAt: Date;
  durationMs: number;
  materialized: MaterializedGoatBrainFile[];
  processResult: GoatBrainCliProcessResult | null;
  output: GoatBrainToolOutput;
  traceContext: GoatBrainCliTraceContext | null;
  syncResult: { ok: true } | { ok: false; error: string } | null;
}) {
  try {
    const db = getDb();
    const insertToolRun = db.insert(goatBrainToolRuns).values({
      id: input.traceId,
      brainRef: input.brainRef,
      userWorkosId: input.userWorkosId,
      chatSessionId: input.traceContext?.chatSessionId ?? null,
      userMessageId: input.traceContext?.userMessageId ?? null,
      assistantMessageId: input.traceContext?.assistantMessageId ?? null,
      toolCallId: input.traceContext?.toolCallId ?? null,
      sourceRef: input.traceContext?.sourceRef ?? null,
      action: input.command,
      ok: input.output.ok,
      exitCode: input.output.exitCode,
      durationMs: input.durationMs,
      tracePath: null,
      trace: {
        schemaVersion: GOAT_BRAIN_TRACE_SCHEMA_VERSION,
        startedAt: input.startedAt.toISOString(),
        argv: input.resolved.argv,
        command: input.resolved.display,
        materialized: input.materialized,
        process: input.processResult
          ? {
              ok: input.processResult.ok,
              exitCode: input.processResult.exitCode,
              timedOut: input.processResult.timedOut === true,
              aborted: input.processResult.aborted === true,
            }
          : null,
        sync: input.syncResult,
        output: {
          ok: input.output.ok,
          exitCode: input.output.exitCode,
          error: input.output.error,
        },
        toolInput: input.traceContext?.toolInput ?? null,
      },
    });
    const completesMcpSetup = isGoatMcpSetupCompletionRun({
      sourceRef: input.traceContext?.sourceRef,
      command: input.command,
      ok: input.output.ok,
    });

    if (!completesMcpSetup) {
      await insertToolRun;
      return;
    }

    // neon-http cannot open an interactive transaction. Its batch API sends both statements
    // through Neon's non-interactive transactional HTTP endpoint, keeping MCP setup completion
    // atomic with the audit row without opening a pooled connection from the web app.
    await db.batch([
      insertToolRun,
      db
        .update(goatUsers)
        .set({ mcpSetupCompletedAt: input.startedAt, updatedAt: new Date() })
        .where(
          and(
            eq(goatUsers.workosUserId, input.userWorkosId),
            isNull(goatUsers.mcpSetupCompletedAt),
          ),
        ),
    ] as const);
  } catch (error) {
    if (process.env.NODE_ENV !== "test") {
      console.error("[goat] Failed to persist Brain tool run", {
        traceId: input.traceId,
        action: input.command,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Tool trace persistence is best effort; the chat response should still be returned.
  }
}

function cleanCliStdout(stdout: string) {
  return truncate(
    stdout
      .split("\n")
      .filter((line) => !line.startsWith("__GOAT_BRAIN_USAGE__"))
      .join("\n")
      .trim(),
    20_000,
  );
}

function parseCliJson(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function splitCliArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

function formatCliDisplay(argv: readonly string[]) {
  return argv.map(formatCliDisplayArg).join(" ");
}

function formatCliDisplayArg(value: string) {
  if (/^[a-zA-Z0-9._/:=@,+-]+$/.test(value)) return value;
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
