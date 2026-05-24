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

export const SESSIONS_QUERY_STALE_TIME_MS = 30_000;
const SIDEBAR_SESSION_LIMIT = 50;

export type SidebarSessionPayload = {
  id: string;
  title: string;
  status: string;
  modelName: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentSessionPayload = {
  id: string;
  agentId: string;
  agentName: string;
  agentPath: string | null;
  title: string;
  status: string;
  modelProvider: string;
  modelName: string;
  e2bSandboxId: string | null;
  workdir: string;
  runLeaseId: string | null;
  abortRequestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentSessionDetailPayload = {
  session: AgentSessionPayload;
  messages: SessionMessage[];
  events: RuntimeEvent[];
  usage: SessionUsageSummary;
  toolUsage: SessionToolUsageSummary;
  cost: SessionCostSummary;
  runnerUrl: string | null;
  streamToken: string | null;
};

export type SidebarSessionSerializable = Omit<SidebarSessionPayload, "createdAt" | "updatedAt"> & {
  createdAt: Date;
  updatedAt: Date;
};

export type AgentSessionDetailSerializable = {
  session: Omit<AgentSessionPayload, "abortRequestedAt" | "createdAt" | "updatedAt"> & {
    abortRequestedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  messages: Array<
    Omit<SessionMessage, "createdAt" | "completedAt"> & {
      createdAt: Date;
      completedAt: Date | null;
    }
  >;
  events: RuntimeEvent[];
  usage: SessionUsageSummary;
  toolUsage: SessionToolUsageSummary;
  cost: SessionCostSummary;
  runnerUrl: string | null;
  token: string | null;
};

export const sessionQueryKeys = {
  list: (workspaceId: string) => ["sessions", workspaceId] as const,
  detail: (workspaceId: string, sessionId: string) => ["session", workspaceId, sessionId] as const,
};

export function serializeSidebarSession(
  session: SidebarSessionSerializable,
): SidebarSessionPayload {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

export function serializeAgentSessionDetail(
  detail: AgentSessionDetailSerializable,
): AgentSessionDetailPayload {
  return {
    session: {
      ...detail.session,
      abortRequestedAt: detail.session.abortRequestedAt?.toISOString() ?? null,
      createdAt: detail.session.createdAt.toISOString(),
      updatedAt: detail.session.updatedAt.toISOString(),
    },
    messages: detail.messages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
      completedAt: message.completedAt?.toISOString() ?? null,
    })),
    events: detail.events,
    usage: detail.usage,
    toolUsage: detail.toolUsage,
    cost: detail.cost,
    runnerUrl: detail.runnerUrl,
    streamToken: detail.token,
  };
}

export function sidebarSessionFromDetail(detail: AgentSessionDetailPayload): SidebarSessionPayload {
  return {
    id: detail.session.id,
    title: detail.session.title,
    status: detail.session.status,
    modelName: detail.session.modelName,
    lastError: detail.session.lastError,
    createdAt: detail.session.createdAt,
    updatedAt: detail.session.updatedAt,
  };
}

export async function fetchSidebarSessions(): Promise<SidebarSessionPayload[]> {
  const response = await fetch("/api/sessions", { credentials: "same-origin" });
  const body = await readJson<{ sessions: SidebarSessionPayload[] }>(response);
  return body.sessions;
}

export async function fetchAgentSession(
  sessionId: string,
): Promise<AgentSessionDetailPayload | null> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    credentials: "same-origin",
  });
  if (response.status === 404) return null;
  const body = await readJson<{ detail: AgentSessionDetailPayload }>(response);
  return body.detail;
}

export function upsertSidebarSession(
  sessions: SidebarSessionPayload[] | undefined,
  session: SidebarSessionPayload,
) {
  const existing = sessions ?? [];
  const next = existing.some((item) => item.id === session.id)
    ? existing.map((item) => (item.id === session.id ? { ...item, ...session } : item))
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

export function mergeAgentSessionDetail(
  current: AgentSessionDetailPayload | undefined,
  incoming: AgentSessionDetailPayload,
): AgentSessionDetailPayload {
  if (!current || current.session.id !== incoming.session.id) return incoming;

  const replayed = replayMissingCurrentEvents(current, incoming);

  return {
    ...replayed,
    session: mergeSession(current.session, replayed.session),
    messages: mergeMessages(current.messages, replayed.messages),
    events: mergeEvents(current.events, replayed.events),
  };
}

export function applyRuntimeEventToSessionDetail(
  detail: AgentSessionDetailPayload,
  event: RuntimeEvent,
  updatedAt = new Date().toISOString(),
): AgentSessionDetailPayload {
  const nextRuntime = applyRuntimeEventToState(toRuntimeState(detail), event);
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

  return {
    ...detail,
    session,
    events: nextRuntime.events,
    messages: nextRuntime.messages,
    usage: nextRuntime.usage,
    toolUsage: nextRuntime.toolUsage,
    cost: nextRuntime.cost,
  };
}

export function addUserMessageToSessionDetail(
  detail: AgentSessionDetailPayload,
  input: { messageId: string; content: string; createdAt?: string },
): AgentSessionDetailPayload {
  if (detail.messages.some((message) => message.id === input.messageId)) return detail;

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

export function seedSessionQueries(
  queryClient: QueryClient,
  workspaceId: string,
  detail: AgentSessionDetailPayload,
) {
  queryClient.setQueryData(sessionQueryKeys.detail(workspaceId, detail.session.id), detail);
  queryClient.setQueryData<SidebarSessionPayload[]>(
    sessionQueryKeys.list(workspaceId),
    (sessions) => upsertSidebarSession(sessions, sidebarSessionFromDetail(detail)),
  );
}

function mergeSession(current: AgentSessionPayload, incoming: AgentSessionPayload) {
  const currentUpdatedAt = Date.parse(current.updatedAt);
  const incomingUpdatedAt = Date.parse(incoming.updatedAt);
  if (Number.isFinite(currentUpdatedAt) && Number.isFinite(incomingUpdatedAt)) {
    if (currentUpdatedAt > incomingUpdatedAt) {
      return {
        ...incoming,
        title: current.title,
        status: current.status,
        abortRequestedAt: current.abortRequestedAt ?? incoming.abortRequestedAt,
        lastError: current.lastError,
        updatedAt: current.updatedAt,
      };
    }
    return incoming;
  }
  return incoming;
}

function replayMissingCurrentEvents(
  current: AgentSessionDetailPayload,
  incoming: AgentSessionDetailPayload,
) {
  const incomingEventIds = new Set(incoming.events.map((event) => event.id));
  return current.events
    .filter((event) => !incomingEventIds.has(event.id))
    .toSorted((left, right) => left.id - right.id)
    .reduce(
      (detail, event) => applyRuntimeEventToSessionDetail(detail, event, current.session.updatedAt),
      incoming,
    );
}

function mergeEvents(current: RuntimeEvent[], incoming: RuntimeEvent[]) {
  const events = new Map<number, RuntimeEvent>();
  for (const event of current) events.set(event.id, event);
  for (const event of incoming) events.set(event.id, event);
  return Array.from(events.values()).toSorted((left, right) => left.id - right.id);
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

  return {
    ...current,
    ...incoming,
    content: keepCurrentContent ? current.content : incoming.content,
    status: keepCurrentCompletion ? current.status : incoming.status,
    completedAt: keepCurrentCompletion ? current.completedAt : incoming.completedAt,
    outputReasoningTokens: Math.max(
      current.outputReasoningTokens ?? 0,
      incoming.outputReasoningTokens ?? 0,
    ),
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

async function readJson<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;

  let message = `Request failed with ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Use the status-based message when the response body is not JSON.
  }
  throw new Error(message);
}
