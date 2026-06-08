import type {
  AgentSessionDetailPayload,
  AgentSessionPayload,
  RelatedSessionPayload,
  SidebarSessionPayload,
} from "@/lib/agent-sessions/payload";
import { type AgentListItemPayload, normalizeAgentConfig } from "@/lib/agents/payload";
import type {
  AgentRow,
  AgentSessionRow,
  InboxItemRow,
  SessionStarRow,
} from "@/lib/collections/types";

/**
 * Selectors map raw synced rows (snake_case Postgres columns) into the
 * camelCase payload shapes the UI already consumes. This is where the
 * serialization that used to live server-side (payload.ts `serializeAgent*`)
 * now happens client-side, over live-query results.
 */

export function agentRowToListItem(row: AgentRow): AgentListItemPayload {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    name: row.name,
    config: normalizeAgentConfig(row.config),
    githubSyncStatus: row.github_sync_status,
    githubSyncError: row.github_sync_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Newest-updated first, matching the previous `fetchAgents` ordering. */
export function sortAgentsByUpdatedDesc(agents: AgentListItemPayload[]): AgentListItemPayload[] {
  return [...agents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Sessions mid-archive must not flash back into the sidebar. The agent_sessions
// shape already excludes archived rows (archived_at IS NULL), but the runner
// archive path sets status="archiving" first and only writes archived_at later
// (and the local path briefly carries status="archived" before Electric streams
// the row out). Excluding both statuses keeps an archiving session hidden across
// that window, so the optimistic delete never visibly reappears.
const SIDEBAR_HIDDEN_STATUSES = new Set(["archiving", "archived"]);
// Mirror loadSidebarSessionsForWorkspace: render the most-recent N sessions plus
// every pinned session (so a pinned-but-stale session always shows).
const SIDEBAR_RECENCY_LIMIT = 50;

/**
 * Join the normalized `agent_sessions` and `session_stars` collections into the
 * camelCase sidebar payload the UI already consumes — the client-side equivalent
 * of the SSR `loadSidebarSessionsForWorkspace` join. The shape proxy already
 * scopes both collections to the current workspace/user, so no ownership filter
 * is needed here.
 */
export function deriveSidebarSessions(
  sessions: AgentSessionRow[],
  stars: SessionStarRow[],
): SidebarSessionPayload[] {
  const starredAtBySession = new Map(stars.map((star) => [star.session_id, star.starred_at]));

  const visible = sessions
    .filter(
      (row) =>
        row.source === "user" &&
        row.archived_at === null &&
        !SIDEBAR_HIDDEN_STATUSES.has(row.status),
    )
    .map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      modelName: row.model_name,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      starredAt: starredAtBySession.get(row.id) ?? null,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return visible.filter(
    (session, index) => index < SIDEBAR_RECENCY_LIMIT || session.starredAt !== null,
  );
}

export type InboxItemPayload = {
  id: string;
  title: string;
  body: string | null;
  steps: string[];
  priority: "urgent" | "high" | "med" | "low" | null;
  dueAt: string | null;
  status: InboxItemRow["status"];
  snoozedUntil: string | null;
  source: string | null;
  sourceSessionId: string | null;
  createdAt: string;
};

export function inboxRowToPayload(row: InboxItemRow): InboxItemPayload {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    steps: row.steps ?? [],
    priority: row.priority,
    dueAt: row.due_at,
    status: row.status,
    snoozedUntil: row.snoozed_until,
    source: row.source,
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
  };
}

const INBOX_PRIORITY_RANK: Record<NonNullable<InboxItemRow["priority"]>, number> = {
  urgent: 0,
  high: 1,
  med: 2,
  low: 3,
};

/**
 * Items the user should see in their inbox right now: open items, plus snoozed items whose
 * snooze window has elapsed. A snoozed item with a future snoozed_until stays hidden (it is still
 * synced so the agent can see it via inbox_list). Sorted by priority, then newest first. Pass the
 * current time so the live query re-derives as a ticking clock advances past snooze windows.
 */
export function deriveVisibleInbox(rows: InboxItemRow[], now: number): InboxItemPayload[] {
  return rows
    .filter(
      (row) =>
        row.status === "open" ||
        (row.status === "snoozed" &&
          (!row.snoozed_until || Date.parse(row.snoozed_until) <= now)),
    )
    .map(inboxRowToPayload)
    .sort((a, b) => {
      const ra = a.priority ? INBOX_PRIORITY_RANK[a.priority] : 4;
      const rb = b.priority ? INBOX_PRIORITY_RANK[b.priority] : 4;
      if (ra !== rb) return ra - rb;
      return b.createdAt.localeCompare(a.createdAt);
    });
}

// Aggregates are a recursive server-side rollup over the session tree (D2) and the
// transcript history floor is served from the snapshot, not synced into a
// collection — both stay empty in the instant placeholder and are filled by the
// server detail fetch.
const EMPTY_USAGE: AgentSessionDetailPayload["usage"] = {
  inputTokens: 0,
  inputNoCacheTokens: 0,
  inputCacheReadTokens: 0,
  inputCacheWriteTokens: 0,
  outputTokens: 0,
  outputTextTokens: 0,
  outputReasoningTokens: 0,
  totalTokens: 0,
};
const EMPTY_TOOL_USAGE: AgentSessionDetailPayload["toolUsage"] = {
  totalCostUsdMicros: 0,
  byProviderOperation: [],
};
const EMPTY_COST: AgentSessionDetailPayload["cost"] = {
  providerCostUsdMicros: 0,
  platformFeeUsdMicros: 0,
  totalCostUsdMicros: 0,
  modelCostUsdMicros: 0,
  toolCostUsdMicros: 0,
  sandboxCostUsdMicros: 0,
};

function sessionRowToPayload(
  row: AgentSessionRow,
  agentsById: Map<string, AgentRow>,
): AgentSessionPayload {
  const agent = agentsById.get(row.agent_id);
  return {
    id: row.id,
    agentId: row.agent_id,
    agentName: agent?.name ?? "",
    agentPath: agent?.path ?? null,
    title: row.title,
    status: row.status,
    source: row.source,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    parentSessionId: row.parent_session_id,
    parentMessageId: row.parent_message_id,
    parentToolCallId: row.parent_tool_call_id,
    e2bSandboxId: row.e2b_sandbox_id,
    workdir: row.workdir,
    // Not synced into the agent_sessions shape; an inspector-only field the
    // server detail fetch fills in. Null is correct for the instant placeholder.
    runLeaseId: null,
    abortRequestedAt: row.abort_requested_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sessionRowToRelated(
  row: AgentSessionRow,
  agentsById: Map<string, AgentRow>,
): RelatedSessionPayload {
  const agent = agentsById.get(row.agent_id);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    agentName: agent?.name ?? "",
    agentPath: agent?.path ?? null,
    parentMessageId: row.parent_message_id,
    parentToolCallId: row.parent_tool_call_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Build the instant session-detail placeholder from the already-synced
 * agent_sessions + agents collections, so the session view paints its chrome
 * (meta + parent/children tree) with no network round-trip — the TanStack DB
 * equivalent of the server `fetchAgentSession` join. The transcript history floor
 * and the recursive usage/cost aggregates are left empty for the server detail
 * fetch to fill (the live transcript itself streams from the Durable Stream).
 * Returns null until the session row has synced, so the caller falls back to the
 * normal loading skeleton.
 */
export function deriveSessionDetailPlaceholder(
  sessionId: string,
  sessions: AgentSessionRow[],
  agents: AgentRow[],
): AgentSessionDetailPayload | null {
  const sessionRow = sessions.find((row) => row.id === sessionId);
  if (!sessionRow) return null;

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const parentRow = sessionRow.parent_session_id
    ? sessions.find((row) => row.id === sessionRow.parent_session_id)
    : undefined;
  const children = sessions
    .filter((row) => row.parent_session_id === sessionId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return {
    session: sessionRowToPayload(sessionRow, agentsById),
    related: {
      parent: parentRow ? sessionRowToRelated(parentRow, agentsById) : null,
      children: children.map((row) => sessionRowToRelated(row, agentsById)),
    },
    messages: [],
    events: [],
    usage: EMPTY_USAGE,
    toolUsage: EMPTY_TOOL_USAGE,
    cost: EMPTY_COST,
    // This projection has no per-step usage rows to read; the live detail query supplies the
    // real context figure once it loads.
    currentContextTokens: 0,
  };
}
