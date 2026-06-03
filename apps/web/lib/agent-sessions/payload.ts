import type { QueryClient } from "@tanstack/react-query";
import {
  applyRuntimeEventToState,
  type RuntimeEvent,
  readString,
  type SessionCostSummary,
  type SessionMessage,
  type SessionRuntimeState,
  type SessionToolUsageSummary,
  type SessionUsageSummary,
} from "@/lib/agent-sessions/runtime-events";
import { agentQueryKeys } from "@/lib/agents/payload";

export const SESSIONS_QUERY_STALE_TIME_MS = 30_000;
const SIDEBAR_SESSION_LIMIT = 50;

export type SidebarSessionPayload = {
  id: string;
  title: string;
  status: string;
  // True while the session is actively working — drives the green sidebar dot.
  // Derived from a real activity signal (a running assistant message, or a
  // running/provisioning status) so it stays correct even when the persisted
  // session status lags behind reality (e.g. stuck on "aborting" / "created").
  active: boolean;
  modelName: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  // ISO timestamp the current user starred this session, or null if unstarred.
  starredAt: string | null;
};

const ACTIVE_SESSION_STATUSES = new Set(["running", "provisioning"]);
// Statuses from which a session can still be producing output. Mirrors
// SessionView's `sessionCanGenerate`, so the sidebar dot agrees with the main
// panel's "working" indicator.
const GENERATABLE_SESSION_STATUSES = new Set(["created", "provisioning", "ready", "running"]);

// A session is "active" (green dot) when it is genuinely working: its status is
// running/provisioning, or an assistant message is still streaming in a session
// that could actually be generating. The message signal hardens the indicator
// against a stale persisted status (the root cause of the dot going missing for
// working sessions); the `canGenerate` guard keeps an orphaned "running" message
// left behind by a failed/aborted/archived session from lighting the dot.
export function isSidebarSessionActive(
  status: string,
  hasRunningAssistantMessage: boolean,
  hasError: boolean,
): boolean {
  if (ACTIVE_SESSION_STATUSES.has(status)) return true;
  return hasRunningAssistantMessage && !hasError && GENERATABLE_SESSION_STATUSES.has(status);
}

export type AgentSessionPayload = {
  id: string;
  agentId: string;
  agentName: string;
  agentPath: string | null;
  title: string;
  status: string;
  source: "user" | "agent";
  modelProvider: string;
  modelName: string;
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
  agentName: string;
  agentPath: string | null;
  parentMessageId: string | null;
  parentToolCallId: string | null;
  createdAt: string;
  updatedAt: string;
};

const LIVE_SESSION_FIELDS = [
  "title",
  "status",
  "abortRequestedAt",
  "lastError",
] as const satisfies ReadonlyArray<keyof AgentSessionPayload>;

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
  runnerUrl: string | null;
};

export type SessionStreamCredentialPayload = {
  runnerUrl: string | null;
  streamToken: string | null;
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
  runnerUrl: string | null;
};

type RuntimeEventSerializable = Omit<RuntimeEvent, "createdAt"> & {
  createdAt?: Date | string | null;
};

export type RelatedSessionSerializable = Omit<RelatedSessionPayload, "createdAt" | "updatedAt"> & {
  createdAt: Date;
  updatedAt: Date;
};

export const sessionQueryKeys = {
  list: (workspaceId: string) => ["sessions", workspaceId] as const,
  detail: (workspaceId: string, sessionId: string) => ["session", workspaceId, sessionId] as const,
  streamCredential: (workspaceId: string, sessionId: string) =>
    ["session-stream-credential", workspaceId, sessionId] as const,
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
    runnerUrl: detail.runnerUrl,
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
    active: isSidebarSessionActive(
      detail.session.status,
      detail.messages.some(
        (message) => message.role === "assistant" && message.status === "running",
      ),
      detail.session.lastError !== null,
    ),
    modelName: detail.session.modelName,
    lastError: detail.session.lastError,
    createdAt: detail.session.createdAt,
    updatedAt: detail.session.updatedAt,
    // The session detail payload does not carry star state; a session projected
    // from detail keeps whatever the cached sidebar entry already had (see
    // upsertSidebarSession), and is treated as unstarred when it is brand new.
    starredAt: null,
  };
}

export async function fetchSidebarSessions(): Promise<SidebarSessionPayload[]> {
  const response = await fetch("/api/sessions", {
    cache: "no-store",
    credentials: "same-origin",
  });
  const body = await readJson(response);
  return parseSidebarSessionsResponse(body).sessions;
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

export async function fetchSessionStreamCredential(
  sessionId: string,
): Promise<SessionStreamCredentialPayload | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stream-token`, {
    cache: "no-store",
    method: "POST",
    credentials: "same-origin",
  });
  if (response.status === 404) return null;
  const body = await readJson(response);
  return parseSessionStreamCredentialResponse(body);
}

export function upsertSidebarSession(
  sessions: SidebarSessionPayload[] | undefined,
  session: SidebarSessionPayload,
) {
  const existing = sessions ?? [];
  const next = existing.some((item) => item.id === session.id)
    ? existing.map((item) =>
        // Preserve server-truth star state: detail projections always carry
        // starredAt = null, which must not clobber an already-starred entry.
        item.id === session.id ? { ...item, ...session, starredAt: item.starredAt } : item,
      )
    : [session, ...existing];

  return next
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, SIDEBAR_SESSION_LIMIT);
}

export function removeSidebarSession(
  sessions: SidebarSessionPayload[] | undefined,
  sessionId: string,
) {
  return (sessions ?? []).filter((session) => session.id !== sessionId);
}

export function setSidebarSessionStar(
  sessions: SidebarSessionPayload[] | undefined,
  sessionId: string,
  starredAt: string | null,
) {
  return (sessions ?? []).map((session) =>
    session.id === sessionId ? { ...session, starredAt } : session,
  );
}

export type ArchiveSidebarSessionResult = { ok: true } | { ok: false; error: string };

// Archive a session with an optimistic sidebar update: the session leaves the list
// immediately, then the server action runs. On failure the previous list is restored so
// the session reappears; on success the detail cache is dropped and the list is refetched
// to reconcile with the server. Extracted as a pure helper so the optimistic-removal and
// rollback-on-error behavior can be unit-tested without rendering the component.
export async function archiveSidebarSessionOptimistically({
  queryClient,
  workspaceId,
  sessionId,
  archive,
}: {
  queryClient: QueryClient;
  workspaceId: string;
  sessionId: string;
  archive: (sessionId: string) => Promise<ArchiveSidebarSessionResult>;
}): Promise<ArchiveSidebarSessionResult> {
  const listKey = sessionQueryKeys.list(workspaceId);
  const previousSessions = queryClient.getQueryData<SidebarSessionPayload[]>(listKey);

  // Optimistically remove the session so the sidebar updates instantly.
  queryClient.setQueryData<SidebarSessionPayload[]>(listKey, (sessions) =>
    removeSidebarSession(sessions, sessionId),
  );

  let result: ArchiveSidebarSessionResult;
  try {
    result = await archive(sessionId);
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : "Could not archive session.",
    };
  }

  if (!result.ok) {
    // Roll back to the pre-archive list so the session reappears.
    queryClient.setQueryData<SidebarSessionPayload[]>(listKey, previousSessions);
    return result;
  }

  queryClient.removeQueries({ queryKey: sessionQueryKeys.detail(workspaceId, sessionId) });
  void queryClient.invalidateQueries({ queryKey: listKey });
  return result;
}

export function mergeAgentSessionDetail(
  current: AgentSessionDetailPayload | undefined,
  incoming: AgentSessionDetailPayload,
): AgentSessionDetailPayload {
  if (!current || current.session.id !== incoming.session.id) {
    return normalizeAgentSessionDetail(incoming);
  }

  const replayed = replayMissingCurrentEvents(current, incoming);

  return normalizeAgentSessionDetail({
    ...replayed,
    session: mergeSession(current.session, replayed.session),
    messages: mergeMessages(current.messages, replayed.messages),
    events: mergeEvents(current.events, replayed.events),
  });
}

export function applyRuntimeEventToSessionDetail(
  detail: AgentSessionDetailPayload,
  event: RuntimeEvent,
  updatedAt = new Date().toISOString(),
): AgentSessionDetailPayload {
  const stampedEvent: RuntimeEvent = event.createdAt
    ? event
    : { ...event, createdAt: new Date().toISOString() };
  const nextRuntime = applyRuntimeEventToState(toRuntimeState(detail), stampedEvent);
  let session: AgentSessionPayload = detail.session;

  if (event.type === "session.status") {
    const status = readString(event.payload.status);
    if (status) {
      session = {
        ...session,
        status,
        lastError: status === "failed" ? session.lastError : null,
        updatedAt,
      };
    }
  }

  if (event.type === "session.error") {
    const message = readString(event.payload.message) || "The session failed.";
    session = { ...session, status: "failed", lastError: message, updatedAt };
  }

  if (event.type === "session.title_updated") {
    const title = readString(event.payload.title);
    if (title) session = { ...session, title, updatedAt };
  }

  return normalizeAgentSessionDetail({
    ...detail,
    session,
    events: nextRuntime.events,
    messages: nextRuntime.messages,
    usage: nextRuntime.usage,
    toolUsage: nextRuntime.toolUsage,
    cost: nextRuntime.cost,
  });
}

export function addUserMessageToSessionDetail(
  detail: AgentSessionDetailPayload,
  input: { messageId: string; content: string; createdAt?: string },
): AgentSessionDetailPayload {
  const existing = detail.messages.find((message) => message.id === input.messageId);
  if (existing) {
    const nextMessage: SessionMessage = {
      ...existing,
      role: "user",
      content: input.content,
      status: "completed",
      createdAt: existing.createdAt ?? input.createdAt ?? new Date().toISOString(),
    };
    if (
      existing.role === nextMessage.role &&
      existing.content === nextMessage.content &&
      existing.status === nextMessage.status &&
      existing.createdAt === nextMessage.createdAt
    ) {
      return detail;
    }

    return {
      ...detail,
      messages: detail.messages.map((message) =>
        message.id === input.messageId ? nextMessage : message,
      ),
    };
  }

  return {
    ...detail,
    messages: [
      ...detail.messages,
      {
        id: input.messageId,
        role: "user",
        content: input.content,
        status: "completed",
        createdAt: input.createdAt ?? new Date().toISOString(),
      },
    ],
  };
}

export function updateSessionStatusInDetail(
  detail: AgentSessionDetailPayload,
  status: string,
): AgentSessionDetailPayload {
  const updatedAt = new Date().toISOString();
  return {
    ...detail,
    session: {
      ...detail.session,
      status,
      abortRequestedAt: status === "aborting" ? updatedAt : detail.session.abortRequestedAt,
      updatedAt,
    },
  };
}

export function invalidateRelatedCachesForSessionEvent(
  queryClient: QueryClient,
  workspaceId: string,
  agentId: string,
  event: RuntimeEvent,
  options: { sessionId?: string } = {},
) {
  if (event.type.startsWith("brain.")) {
    void queryClient.invalidateQueries({ queryKey: agentQueryKeys.list(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: agentQueryKeys.detail(workspaceId, agentId) });
  }

  if (
    options.sessionId &&
    (event.type === "session.delegated_usage" ||
      (event.type === "tool.completed" && readString(event.payload.name) === "delegate_to_agent"))
  ) {
    void queryClient.invalidateQueries({
      queryKey: sessionQueryKeys.detail(workspaceId, options.sessionId),
    });
  }
}

export function seedSessionQueries(
  queryClient: QueryClient,
  workspaceId: string,
  detail: AgentSessionDetailPayload,
) {
  queryClient.setQueryData(sessionQueryKeys.detail(workspaceId, detail.session.id), detail);
  if (detail.session.source !== "user") {
    queryClient.setQueryData<SidebarSessionPayload[]>(
      sessionQueryKeys.list(workspaceId),
      (sessions) => removeSidebarSession(sessions, detail.session.id),
    );
    return;
  }

  const projected = sidebarSessionFromDetail(detail);
  queryClient.setQueryData<SidebarSessionPayload[]>(
    sessionQueryKeys.list(workspaceId),
    (sessions) => {
      const existing = sessions?.find((session) => session.id === projected.id);
      if (existing && sidebarSessionEquals(existing, projected)) return sessions;
      return upsertSidebarSession(sessions, projected);
    },
  );
}

function sidebarSessionEquals(left: SidebarSessionPayload, right: SidebarSessionPayload) {
  return (
    left.title === right.title &&
    left.status === right.status &&
    left.active === right.active &&
    left.modelName === right.modelName &&
    left.lastError === right.lastError &&
    left.updatedAt === right.updatedAt &&
    left.createdAt === right.createdAt
  );
}

// Server payload wins for every field except LIVE_SESSION_FIELDS while the local copy is newer.
// New fields default to "server is authority."
function mergeSession(current: AgentSessionPayload, incoming: AgentSessionPayload) {
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const incomingUpdatedAt = Date.parse(incoming.updatedAt);
  if (Number.isFinite(currentUpdatedAt) && Number.isFinite(incomingUpdatedAt)) {
    if (currentUpdatedAt > incomingUpdatedAt) {
      const next = { ...incoming, updatedAt: current.updatedAt };
      for (const field of LIVE_SESSION_FIELDS) {
        switch (field) {
          case "title":
            next.title = current.title;
            break;
          case "status":
            next.status = current.status;
            break;
          case "abortRequestedAt":
            next.abortRequestedAt = current.abortRequestedAt ?? incoming.abortRequestedAt;
            break;
          case "lastError":
            next.lastError = current.lastError;
            break;
        }
      }
      return next;
    }
    return incoming;
  }
  return incoming;
}

// Server detail's usage/cost/toolUsage aggregates already include every event the server has
// persisted, even those past the events-list cap. Only replay events strictly newer than the
// highest id the server returned — those are the ones the server's aggregates haven't seen yet.
function replayMissingCurrentEvents(
  current: AgentSessionDetailPayload,
  incoming: AgentSessionDetailPayload,
) {
  const maxIncomingEventId = incoming.events.reduce(
    (max, event) => Math.max(max, event.id ?? 0),
    0,
  );
  return current.events
    .filter((event) => typeof event.id === "number" && event.id > maxIncomingEventId)
    .toSorted((left, right) => (left.id ?? 0) - (right.id ?? 0))
    .reduce(
      (detail, event) => applyRuntimeEventToSessionDetail(detail, event, current.session.updatedAt),
      incoming,
    );
}

function mergeEvents(current: RuntimeEvent[], incoming: RuntimeEvent[]) {
  const events = new Map<number, RuntimeEvent>();
  for (const event of incoming) {
    if (typeof event.id === "number") events.set(event.id, event);
  }

  const result: RuntimeEvent[] = [];
  const seen = new Set<number>();
  for (const event of current) {
    if (typeof event.id !== "number") {
      result.push(event);
      continue;
    }
    const replacement = events.get(event.id) ?? event;
    result.push(replacement);
    seen.add(event.id);
  }

  for (const event of incoming) {
    if (typeof event.id !== "number" || seen.has(event.id)) continue;
    result.push(event);
    seen.add(event.id);
  }

  return result;
}

function mergeMessages(current: SessionMessage[], incoming: SessionMessage[]) {
  const messages = new Map<string, SessionMessage>();
  for (const message of current) messages.set(message.id, message);
  for (const message of incoming) {
    const existing = messages.get(message.id);
    messages.set(message.id, existing ? mergeMessage(existing, message) : message);
  }
  return Array.from(messages.values()).toSorted(
    (left, right) => Date.parse(left.createdAt ?? "") - Date.parse(right.createdAt ?? ""),
  );
}

function mergeMessage(current: SessionMessage, incoming: SessionMessage): SessionMessage {
  const keepCurrentContent =
    current.status === "running" &&
    incoming.status !== "completed" &&
    current.content.length > incoming.content.length;
  const keepCurrentCompletion = current.status === "completed" && incoming.status !== "completed";
  const incomingIsAuthoritative = incoming.status === "completed";

  return {
    ...current,
    ...incoming,
    content: keepCurrentContent ? current.content : incoming.content,
    status: keepCurrentCompletion ? current.status : incoming.status,
    completedAt: keepCurrentCompletion ? current.completedAt : incoming.completedAt,
    outputReasoningTokens: incomingIsAuthoritative
      ? (incoming.outputReasoningTokens ?? current.outputReasoningTokens ?? 0)
      : Math.max(current.outputReasoningTokens ?? 0, incoming.outputReasoningTokens ?? 0),
    thinkingDurationSeconds: incoming.thinkingDurationSeconds ?? current.thinkingDurationSeconds,
  };
}

function toRuntimeState(detail: AgentSessionDetailPayload): SessionRuntimeState {
  return {
    events: detail.events,
    messages: detail.messages,
    usage: detail.usage,
    toolUsage: detail.toolUsage,
    cost: detail.cost,
    currentStatus: detail.session.status,
    lastError: detail.session.lastError,
  };
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

export function parseSessionStreamCredentialResponse(
  value: unknown,
): SessionStreamCredentialPayload {
  const record = assertRecord(value, "session stream credential response");
  return {
    runnerUrl: readNullableStringField(record, "runnerUrl"),
    streamToken: readNullableStringField(record, "streamToken"),
  };
}

export function parseSidebarSessionPayload(value: unknown): SidebarSessionPayload {
  const record = assertRecord(value, "sidebar session");
  return {
    id: readStringField(record, "id"),
    title: readNonEmptyStringField(record, "title"),
    status: readNonEmptyStringField(record, "status"),
    active: readOptionalBooleanField(record, "active") ?? false,
    modelName: readNonEmptyStringField(record, "modelName"),
    lastError: readNullableStringField(record, "lastError"),
    createdAt: readStringField(record, "createdAt"),
    updatedAt: readStringField(record, "updatedAt"),
    starredAt: readNullableStringField(record, "starredAt"),
  };
}

export function parseAgentSessionDetailPayload(value: unknown): AgentSessionDetailPayload {
  const record = assertRecord(value, "session detail");
  return normalizeAgentSessionDetail({
    session: parseAgentSessionPayload(record.session),
    related: parseRelatedSessions(record.related),
    messages: assertArray(record.messages, "messages").map(parseSessionMessage),
    events: assertArray(record.events, "events").map(parseRuntimeEventPayload),
    usage: parseUsageSummary(record.usage),
    toolUsage: parseToolUsageSummary(record.toolUsage),
    cost: parseCostSummary(record.cost),
    runnerUrl: readNullableStringField(record, "runnerUrl"),
  });
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
    modelProvider: readStringField(record, "modelProvider"),
    modelName: readStringField(record, "modelName"),
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

  return message;
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

function readSessionSource(record: Record<string, unknown>, field: string): "user" | "agent" {
  const value = readStringField(record, field);
  if (value !== "user" && value !== "agent") throw new Error(`Invalid ${field}.`);
  return value;
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
