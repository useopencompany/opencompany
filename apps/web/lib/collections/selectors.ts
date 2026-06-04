import type { SidebarSessionPayload } from "@/lib/agent-sessions/payload";
import { type AgentListItemPayload, normalizeAgentConfig } from "@/lib/agents/payload";
import type { AgentRow, AgentSessionRow, SessionStarRow } from "@/lib/collections/types";

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
