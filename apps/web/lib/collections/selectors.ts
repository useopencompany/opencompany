import { type AgentListItemPayload, normalizeAgentConfig } from "@/lib/agents/payload";
import type { AgentRow } from "@/lib/collections/types";

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
