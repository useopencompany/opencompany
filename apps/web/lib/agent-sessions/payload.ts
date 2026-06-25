import { isCodexReasoningEffort } from "@opencompany/agent-runtime";
import type { AgentEngine, CodexReasoningEffort } from "@opencompany/agent-runtime/types";
import type { QueryClient } from "@tanstack/react-query";
import {
  type RuntimeEvent,
  type SessionCostSummary,
  type SessionMessage,
  type SessionToolUsageSummary,
  type SessionUsageSummary,
} from "@/lib/agent-sessions/runtime-events";
import { isSendMode } from "@/lib/agent-sessions/send-mode";

export const SESSIONS_QUERY_STALE_TIME_MS = 30_000;

export type SidebarSessionPayload = {
  id: string;
  title: string;
  status: string;
  // Where the session originated: "user" (web), "agent" (delegated), "memory" (memory-keeper pass),
  // or "whatsapp" (messaging channel). Drives the source badge + which surface lists it.
  source: "user" | "agent" | "memory" | "whatsapp";
  engine: AgentEngine;
  modelName: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  // ISO timestamp the current user starred this session, or null if unstarred.
  starredAt: string | null;
  // True when the agent finished a turn (completed/failed/awaiting_*) more recently than
  // the user last viewed this session. Drives the sidebar's "unseen" blue dot. Derived
  // from agent_sessions.last_turn_finished_at vs last_seen_at via isSessionUnseen.
  unseen: boolean;
};

export type AgentSessionPayload = {
  id: string;
  agentId: string;
  agentName: string;
  agentPath: string | null;
  title: string;
  status: string;
  source: "user" | "agent" | "memory" | "whatsapp";
  engine: AgentEngine;
  modelProvider: string;
  modelName: string;
  codexReasoningEffort: CodexReasoningEffort;
  codexPlanModeEnabled: boolean;
  codexPlanModeReasoningEffort: CodexReasoningEffort;
  parentSessionId: string | null;
  parentMessageId: string | null;
  parentToolCallId: string | null;
  e2bSandboxId: string | null;
  workdir: string;
  runLeaseId: string | null;
  abortRequestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RelatedSessionPayload = {
  id: string;
  title: string;
  status: string;
  // "memory" marks a background memory-keeper pass; the UI labels it distinctly from delegated
  // ("agent") children. "user" never appears here (those are not related children).
  source: "user" | "agent" | "memory" | "whatsapp";
  agentName: string;
  agentPath: string | null;
  parentMessageId: string | null;
  parentToolCallId: string | null;
  createdAt: string;
  updatedAt: string;
};

// The latest `debug.model_request` snapshot for the session (system prompt + tool catalog),
// carried as a top-level field rather than inside `events`. The runner emits one per turn, but
// they are large and hidden from the inspector, so they are excluded from the windowed `events`
// list (see loadAgentSessionDetailForWorkspace) and the single most-recent one is surfaced here for
// the "Copy Debug JSON" export. Loosely typed: it is debug-only and tolerant of legacy field names.
export type ModelRequestSnapshotPayload = Record<string, unknown>;

export type AgentSessionDetailPayload = {
  session: AgentSessionPayload;
  related: {
    parent: RelatedSessionPayload | null;
    children: RelatedSessionPayload[];
  };
  messages: SessionMessage[];
  events: RuntimeEvent[];
  usage: SessionUsageSummary;
  toolUsage: SessionToolUsageSummary;
  cost: SessionCostSummary;
  // How full the model's context window currently is, in tokens: the latest model step's
  // input + output for this session (NOT the cumulative `usage` rollup, which only grows).
  currentContextTokens: number;
  // Highest non-debug runtime event id included in the server aggregate snapshot. Live stream
  // aggregate events above this id can be added to the snapshot without double-counting replayed
  // history.
  latestEventId: number;
  latestModelRequest?: ModelRequestSnapshotPayload | null;
};

export type SidebarSessionSerializable = Omit<
  SidebarSessionPayload,
  "createdAt" | "updatedAt" | "starredAt"
> & {
  createdAt: Date;
  updatedAt: Date;
  starredAt: Date | null;
};

export type AgentSessionDetailSerializable = {
  session: Omit<AgentSessionPayload, "abortRequestedAt" | "createdAt" | "updatedAt"> & {
    abortRequestedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  related: {
    parent: RelatedSessionSerializable | null;
    children: RelatedSessionSerializable[];
  };
  messages: Array<
    Omit<SessionMessage, "createdAt" | "completedAt"> & {
      createdAt: Date;
      completedAt: Date | null;
    }
  >;
  events: RuntimeEventSerializable[];
  usage: SessionUsageSummary;
  toolUsage: SessionToolUsageSummary;
  cost: SessionCostSummary;
  currentContextTokens: number;
  latestEventId: number;
  latestModelRequest?: ModelRequestSnapshotPayload | null;
};

type RuntimeEventSerializable = Omit<RuntimeEvent, "createdAt"> & {
  createdAt?: Date | string | null;
};

export type RelatedSessionSerializable = Omit<RelatedSessionPayload, "createdAt" | "updatedAt"> & {
  createdAt: Date;
  updatedAt: Date;
};

export const sessionQueryKeys = {
  detail: (workspaceId: string, sessionId: string) => ["session", workspaceId, sessionId] as const,
};

export function serializeSidebarSession(
  session: SidebarSessionSerializable,
): SidebarSessionPayload {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    starredAt: session.starredAt?.toISOString() ?? null,
  };
}

/**
 * Single source of truth for the sidebar "unseen" rule: the agent has yielded a turn
 * (lastTurnFinishedAt set) more recently than the user last viewed it (lastSeenAt).
 * Accepts Date or ISO string so the SSR loader and the client Electric selector share
 * one implementation; parsing via Date avoids any timestamp string-format assumption.
 */
export function isSessionUnseen(
  lastTurnFinishedAt: Date | string | null,
  lastSeenAt: Date | string | null,
): boolean {
  if (lastTurnFinishedAt == null) return false;
  const finished = new Date(lastTurnFinishedAt).getTime();
  if (Number.isNaN(finished)) return false;
  if (lastSeenAt == null) return true;
  return new Date(lastSeenAt).getTime() < finished;
}

export function serializeAgentSessionDetail(
  detail: AgentSessionDetailSerializable,
): AgentSessionDetailPayload {
  return normalizeAgentSessionDetail({
    session: {
      ...detail.session,
      abortRequestedAt: detail.session.abortRequestedAt?.toISOString() ?? null,
      createdAt: detail.session.createdAt.toISOString(),
      updatedAt: detail.session.updatedAt.toISOString(),
    },
    related: {
      parent: detail.related.parent ? serializeRelatedSession(detail.related.parent) : null,
      children: detail.related.children.map(serializeRelatedSession),
    },
    messages: detail.messages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
      completedAt: message.completedAt?.toISOString() ?? null,
    })),
    events: detail.events.map(serializeRuntimeEvent),
    usage: detail.usage,
    toolUsage: detail.toolUsage,
    cost: detail.cost,
    currentContextTokens: detail.currentContextTokens,
    latestEventId: detail.latestEventId,
    // Omit the key entirely when absent so the parse round-trip stays exact for sessions with no
    // recorded model-request snapshot.
    ...(detail.latestModelRequest ? { latestModelRequest: detail.latestModelRequest } : {}),
  });
}

function serializeRelatedSession(session: RelatedSessionSerializable): RelatedSessionPayload {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function serializeRuntimeEvent(event: RuntimeEventSerializable): RuntimeEvent {
  return {
    id: event.id,
    type: event.type,
    messageId: event.messageId,
    payload: event.payload,
    ...(event.createdAt ? { createdAt: serializeDateValue(event.createdAt) } : {}),
  };
}

function serializeDateValue(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

export function sidebarSessionFromDetail(detail: AgentSessionDetailPayload): SidebarSessionPayload {
  return {
    id: detail.session.id,
    title: detail.session.title,
    status: detail.session.status,
    source: detail.session.source,
    engine: detail.session.engine,
    modelName: detail.session.modelName,
    lastError: detail.session.lastError,
    createdAt: detail.session.createdAt,
    updatedAt: detail.session.updatedAt,
    // The session detail payload does not carry star state; a session projected
    // from detail keeps whatever the cached sidebar entry already had (see
    // upsertSidebarSession), and is treated as unstarred when it is brand new.
    starredAt: null,
    // Projected from detail only for freshly created/submitted sessions (about to run),
    // never a finished-but-unseen turn; the live Electric row corrects this if it ever is.
    unseen: false,
  };
}

export async function fetchAgentSession(
  sessionId: string,
): Promise<AgentSessionDetailPayload | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.status === 404) return null;
  const body = await readJson(response);
  return parseAgentSessionDetailResponse(body).detail;
}

export function seedSessionQueries(
  queryClient: QueryClient,
  workspaceId: string,
  detail: AgentSessionDetailPayload,
) {
  queryClient.setQueryData(sessionQueryKeys.detail(workspaceId, detail.session.id), detail);
}

export function parseSidebarSessionsResponse(value: unknown): {
  sessions: SidebarSessionPayload[];
} {
  const record = assertRecord(value, "sessions response");
  const sessions = assertArray(record.sessions, "sessions");
  return { sessions: sessions.map(parseSidebarSessionPayload) };
}

export function parseAgentSessionDetailResponse(value: unknown): {
  detail: AgentSessionDetailPayload;
} {
  const record = assertRecord(value, "session detail response");
  return { detail: parseAgentSessionDetailPayload(record.detail) };
}

export function parseSidebarSessionPayload(value: unknown): SidebarSessionPayload {
  const record = assertRecord(value, "sidebar session");
  return {
    id: readStringField(record, "id"),
    title: readNonEmptyStringField(record, "title"),
    status: readNonEmptyStringField(record, "status"),
    // Tolerant of payloads cached before `source` was carried on the sidebar shape.
    source: readOptionalSessionSource(record, "source") ?? "user",
    engine: readOptionalSessionEngine(record, "engine") ?? "opencompany",
    modelName: readNonEmptyStringField(record, "modelName"),
    lastError: readNullableStringField(record, "lastError"),
    createdAt: readStringField(record, "createdAt"),
    updatedAt: readStringField(record, "updatedAt"),
    starredAt: readNullableStringField(record, "starredAt"),
    // Tolerate payloads serialized before this field existed: absent ⇒ not unseen.
    unseen: readOptionalBooleanField(record, "unseen") ?? false,
  };
}

function readOptionalSessionSource(
  record: Record<string, unknown>,
  field: string,
): "user" | "agent" | "memory" | "whatsapp" | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  return readSessionSource(record, field);
}

export function parseAgentSessionDetailPayload(value: unknown): AgentSessionDetailPayload {
  const record = assertRecord(value, "session detail");
  const latestModelRequest = parseLatestModelRequest(record.latestModelRequest);
  return normalizeAgentSessionDetail({
    session: parseAgentSessionPayload(record.session),
    related: parseRelatedSessions(record.related),
    messages: assertArray(record.messages, "messages").map(parseSessionMessage),
    events: assertArray(record.events, "events").map(parseRuntimeEventPayload),
    usage: parseUsageSummary(record.usage),
    toolUsage: parseToolUsageSummary(record.toolUsage),
    cost: parseCostSummary(record.cost),
    // Tolerant of absence so payloads cached before this field shipped still parse.
    currentContextTokens: readOptionalNumberField(record, "currentContextTokens") ?? 0,
    latestEventId:
      readOptionalNumberField(record, "latestEventId") ??
      maxRuntimeEventId(assertArray(record.events, "events")),
    // Conditionally included so payloads without a snapshot stay byte-for-byte equal across the
    // serialize/parse round trip (and so older cached payloads parse unchanged).
    ...(latestModelRequest ? { latestModelRequest } : {}),
  });
}

function maxRuntimeEventId(events: unknown[]) {
  let max = 0;
  for (const item of events) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = (item as Record<string, unknown>).id;
    if (typeof id === "number" && Number.isFinite(id)) max = Math.max(max, id);
  }
  return max;
}

// Debug-only snapshot — accept any object verbatim (tolerant of legacy field names), reject
// anything that is not a plain object so the export never carries a malformed value.
function parseLatestModelRequest(value: unknown): ModelRequestSnapshotPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ModelRequestSnapshotPayload;
}

function normalizeAgentSessionDetail(detail: AgentSessionDetailPayload): AgentSessionDetailPayload {
  if (detail.session.status !== "failed") return detail;

  let changed = false;
  const messages = detail.messages.map((message) => {
    if (message.role !== "assistant" || message.status !== "running") return message;
    changed = true;
    return {
      ...message,
      status: "failed",
      completedAt: message.completedAt ?? detail.session.updatedAt,
    };
  });

  return changed ? { ...detail, messages } : detail;
}

function parseAgentSessionPayload(value: unknown): AgentSessionPayload {
  const record = assertRecord(value, "session");
  return {
    id: readStringField(record, "id"),
    agentId: readStringField(record, "agentId"),
    agentName: readStringField(record, "agentName"),
    agentPath: readNullableStringField(record, "agentPath"),
    title: readStringField(record, "title"),
    status: readStringField(record, "status"),
    source: readSessionSource(record, "source"),
    engine: readOptionalSessionEngine(record, "engine") ?? "opencompany",
    modelProvider: readStringField(record, "modelProvider"),
    modelName: readStringField(record, "modelName"),
    codexReasoningEffort:
      readOptionalCodexReasoningEffort(record, "codexReasoningEffort") ?? "high",
    codexPlanModeEnabled: readOptionalBooleanField(record, "codexPlanModeEnabled") ?? false,
    codexPlanModeReasoningEffort:
      readOptionalCodexReasoningEffort(record, "codexPlanModeReasoningEffort") ?? "high",
    parentSessionId: readNullableStringField(record, "parentSessionId"),
    parentMessageId: readNullableStringField(record, "parentMessageId"),
    parentToolCallId: readNullableStringField(record, "parentToolCallId"),
    e2bSandboxId: readNullableStringField(record, "e2bSandboxId"),
    workdir: readStringField(record, "workdir"),
    runLeaseId: readNullableStringField(record, "runLeaseId"),
    abortRequestedAt: readNullableStringField(record, "abortRequestedAt"),
    lastError: readNullableStringField(record, "lastError"),
    createdAt: readStringField(record, "createdAt"),
    updatedAt: readStringField(record, "updatedAt"),
  };
}

function parseRelatedSessions(value: unknown): AgentSessionDetailPayload["related"] {
  if (value === undefined) return { parent: null, children: [] };
  const record = assertRecord(value, "related sessions");
  return {
    parent:
      record.parent === null || record.parent === undefined
        ? null
        : parseRelatedSessionPayload(record.parent),
    children: assertArray(record.children, "related children").map(parseRelatedSessionPayload),
  };
}

function parseRelatedSessionPayload(value: unknown): RelatedSessionPayload {
  const record = assertRecord(value, "related session");
  return {
    id: readStringField(record, "id"),
    title: readNonEmptyStringField(record, "title"),
    status: readNonEmptyStringField(record, "status"),
    // Tolerant: payloads cached before the memory-keeper feature lack `source`; treat those as the
    // generic "user" (they predate any memory pass, so the Memory label simply won't show).
    source: readSessionSourceOrDefault(record, "source", "user"),
    agentName: readNonEmptyStringField(record, "agentName"),
    agentPath: readNullableStringField(record, "agentPath"),
    parentMessageId: readNullableStringField(record, "parentMessageId"),
    parentToolCallId: readNullableStringField(record, "parentToolCallId"),
    createdAt: readStringField(record, "createdAt"),
    updatedAt: readStringField(record, "updatedAt"),
  };
}

function parseSessionMessage(value: unknown): SessionMessage {
  const record = assertRecord(value, "message");
  const message: SessionMessage = {
    id: readStringField(record, "id"),
    role: readStringField(record, "role"),
    content: readStringField(record, "content"),
    status: readStringField(record, "status"),
  };

  if ("modelMessage" in record) message.modelMessage = readNullableRecord(record.modelMessage);
  if ("internal" in record) {
    const internal = readOptionalBooleanField(record, "internal");
    if (internal !== undefined) message.internal = internal;
  }
  if ("sendMode" in record) {
    // Carry the mid-run send-mode through serialize→parse so the "steered" caption survives a
    // client refetch/reload; an unknown/legacy NULL value just leaves it unset (plain bubble).
    const sendMode = readNullableStringField(record, "sendMode");
    if (isSendMode(sendMode)) message.sendMode = sendMode;
  }
  if ("toolName" in record) message.toolName = readNullableStringField(record, "toolName");
  if ("toolCallId" in record) message.toolCallId = readNullableStringField(record, "toolCallId");
  if ("responseToMessageId" in record) {
    message.responseToMessageId = readNullableStringField(record, "responseToMessageId");
  }
  if ("outputReasoningTokens" in record) {
    message.outputReasoningTokens = readOptionalNumberField(record, "outputReasoningTokens");
  }
  if ("createdAt" in record) message.createdAt = readOptionalStringField(record, "createdAt");
  if ("completedAt" in record) {
    message.completedAt = readOptionalNullableStringField(record, "completedAt");
  }
  if ("thinkingDurationSeconds" in record) {
    message.thinkingDurationSeconds = readOptionalNumberField(record, "thinkingDurationSeconds");
  }
  if ("attachments" in record && record.attachments !== undefined) {
    message.attachments = parseSessionMessageAttachments(record.attachments);
  }

  return message;
}

function parseSessionMessageAttachments(
  value: unknown,
): NonNullable<SessionMessage["attachments"]> {
  return assertArray(value, "attachments").map((item) => {
    const record = assertRecord(item, "attachment");
    const kind = readStringField(record, "kind");
    if (kind !== "image" && kind !== "pdf" && kind !== "text") {
      throw new Error("Invalid attachment kind.");
    }
    return {
      id: readStringField(record, "id"),
      kind,
      mediaType: readStringField(record, "mediaType"),
      filename: readStringField(record, "filename"),
    };
  });
}

function parseRuntimeEventPayload(value: unknown): RuntimeEvent {
  const record = assertRecord(value, "runtime event");
  const event: RuntimeEvent = {
    id: readNumberField(record, "id"),
    type: readStringField(record, "type"),
    messageId: readNullableStringField(record, "messageId"),
    payload: assertRecord(record.payload, "runtime event payload"),
  };
  if ("createdAt" in record) {
    const createdAt = readOptionalStringField(record, "createdAt");
    if (createdAt !== undefined) event.createdAt = createdAt;
  }
  return event;
}

function parseUsageSummary(value: unknown): SessionUsageSummary {
  const record = assertRecord(value, "usage summary");
  return {
    inputTokens: readNumberField(record, "inputTokens"),
    inputNoCacheTokens: readNumberField(record, "inputNoCacheTokens"),
    inputCacheReadTokens: readNumberField(record, "inputCacheReadTokens"),
    inputCacheWriteTokens: readNumberField(record, "inputCacheWriteTokens"),
    outputTokens: readNumberField(record, "outputTokens"),
    outputTextTokens: readNumberField(record, "outputTextTokens"),
    outputReasoningTokens: readNumberField(record, "outputReasoningTokens"),
    totalTokens: readNumberField(record, "totalTokens"),
  };
}

function parseToolUsageSummary(value: unknown): SessionToolUsageSummary {
  const record = assertRecord(value, "tool usage summary");
  return {
    totalCostUsdMicros: readNumberField(record, "totalCostUsdMicros"),
    byProviderOperation: assertArray(record.byProviderOperation, "byProviderOperation").map(
      (item) => {
        const operation = assertRecord(item, "tool usage operation");
        return {
          provider: readStringField(operation, "provider"),
          operation: readStringField(operation, "operation"),
          costUsdMicros: readNumberField(operation, "costUsdMicros"),
          calls: readNumberField(operation, "calls"),
        };
      },
    ),
  };
}

function parseCostSummary(value: unknown): SessionCostSummary {
  const record = assertRecord(value, "cost summary");
  return {
    providerCostUsdMicros: readNumberField(record, "providerCostUsdMicros"),
    platformFeeUsdMicros: readNumberField(record, "platformFeeUsdMicros"),
    totalCostUsdMicros: readNumberField(record, "totalCostUsdMicros"),
    modelCostUsdMicros: readNumberField(record, "modelCostUsdMicros"),
    toolCostUsdMicros: readNumberField(record, "toolCostUsdMicros"),
    // Tolerant: payloads cached before sandbox billing shipped won't carry this field.
    sandboxCostUsdMicros: readOptionalNumberField(record, "sandboxCostUsdMicros") ?? 0,
  };
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function assertArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function readStringField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`Invalid ${field}.`);
  return value;
}

function readNonEmptyStringField(record: Record<string, unknown>, field: string) {
  const value = readStringField(record, field);
  if (value.trim() === "") throw new Error(`Invalid ${field}.`);
  return value;
}

function readSessionSource(
  record: Record<string, unknown>,
  field: string,
): "user" | "agent" | "memory" | "whatsapp" {
  const value = readStringField(record, field);
  if (value !== "user" && value !== "agent" && value !== "memory" && value !== "whatsapp") {
    throw new Error(`Invalid ${field}.`);
  }
  return value;
}

function readSessionSourceOrDefault(
  record: Record<string, unknown>,
  field: string,
  fallback: "user" | "agent" | "memory" | "whatsapp",
): "user" | "agent" | "memory" | "whatsapp" {
  const value = record[field];
  if (value === "user" || value === "agent" || value === "memory" || value === "whatsapp") {
    return value;
  }
  return fallback;
}

function readOptionalSessionEngine(
  record: Record<string, unknown>,
  field: string,
): AgentEngine | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (value === "opencompany" || value === "codex") return value;
  throw new Error(`Invalid ${field}.`);
}

function readOptionalCodexReasoningEffort(
  record: Record<string, unknown>,
  field: string,
): CodexReasoningEffort | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value === "string" && isCodexReasoningEffort(value)) return value;
  throw new Error(`Invalid ${field}.`);
}

function readOptionalStringField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Invalid ${field}.`);
  return value;
}

function readNullableStringField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`Invalid ${field}.`);
  return value;
}

function readOptionalNullableStringField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw new Error(`Invalid ${field}.`);
  return value;
}

function readOptionalBooleanField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid ${field}.`);
  return value;
}

function readNumberField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

function readOptionalNumberField(record: Record<string, unknown>, field: string) {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${field}.`);
  return value;
}

function readNullableRecord(value: unknown) {
  if (value === null || value === undefined) return null;
  return assertRecord(value, "record field");
}

async function readJson(response: Response): Promise<unknown> {
  if (response.ok) return response.json() as Promise<unknown>;

  let message = `Request failed with ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Use the status-based message when the response body is not JSON.
  }
  throw new Error(message);
}
