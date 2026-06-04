import { archiveAgentSession, setSessionStar } from "@/lib/agent-sessions/actions";
import { deleteAgent } from "@/lib/agents/actions";
import { createElectricCollection } from "@/lib/collections/electric";
import type { AgentRow, AgentSessionRow, SessionStarRow } from "@/lib/collections/types";

/**
 * All client collections for a workspace. Built by a factory (not module
 * singletons) because every shape is scoped to the active workspace/user and
 * the proxy applies that scope server-side — a fresh set is created whenever
 * the workspace changes (see CollectionsProvider).
 *
 * Workspace-wide collections (agents, sessions, stars) sync as soon as a live
 * query subscribes. Per-session collections (messages, events) are created
 * lazily per open session via `sessionCollections(sessionId)` so each only
 * syncs the rows for the session currently on screen.
 */
export function createCollections(workspaceId: string) {
  const agents = createElectricCollection<AgentRow>({
    id: `agents:${workspaceId}`,
    table: "agents",
    getKey: (row) => row.id,
    onDelete: async ({ transaction }) => {
      const mutation = transaction.mutations[0];
      if (!mutation) throw new Error("Delete mutation had no target row.");
      const result = await deleteAgent(String(mutation.key));
      if (!result.ok) throw new Error(result.error);
      return { txid: result.txid };
    },
  });

  const agentSessions = createElectricCollection<AgentSessionRow>({
    id: `agent_sessions:${workspaceId}`,
    table: "agent_sessions",
    getKey: (row) => row.id,
    // The sidebar's only "delete" affordance is archive (a soft delete). An
    // optimistic delete() removes the row from the sidebar at once; the handler
    // archives it and returns the txid Electric will observe (status="archiving"
    // for sandbox sessions, archived_at for local ones), so the overlay drops
    // cleanly. A failure throws → the row rolls back into the sidebar.
    onDelete: async ({ transaction }) => {
      const mutation = transaction.mutations[0];
      if (!mutation) throw new Error("Archive mutation had no target row.");
      const result = await archiveAgentSession(String(mutation.key));
      if (!result.ok) throw new Error(result.error);
      return { txid: result.txid };
    },
  });

  const sessionStars = createElectricCollection<SessionStarRow>({
    id: `session_stars:${workspaceId}`,
    table: "session_stars",
    getKey: (row) => row.session_id,
    // Pin: insert a star row optimistically, persist via setSessionStar(true).
    onInsert: async ({ transaction }) => {
      const mutation = transaction.mutations[0];
      if (!mutation) throw new Error("Star mutation had no target row.");
      const result = await setSessionStar(String(mutation.key), true);
      if (!result.ok) throw new Error(result.error);
      return { txid: result.txid };
    },
    // Unpin: delete the star row optimistically, persist via setSessionStar(false).
    onDelete: async ({ transaction }) => {
      const mutation = transaction.mutations[0];
      if (!mutation) throw new Error("Unstar mutation had no target row.");
      const result = await setSessionStar(String(mutation.key), false);
      if (!result.ok) throw new Error(result.error);
      return { txid: result.txid };
    },
  });

  return { workspaceId, agents, agentSessions, sessionStars };
}

export type Collections = ReturnType<typeof createCollections>;
