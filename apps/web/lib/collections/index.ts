import { createCollection, localOnlyCollectionOptions } from "@tanstack/react-db";
import { deleteAgent } from "@/lib/agents/actions";
import { createElectricCollection } from "@/lib/collections/electric";
import type {
  AgentRow,
  AgentSessionEventRow,
  AgentSessionMessageRow,
  AgentSessionRow,
  SessionStarRow,
  TransientDelta,
} from "@/lib/collections/types";

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
  });

  const sessionStars = createElectricCollection<SessionStarRow>({
    id: `session_stars:${workspaceId}`,
    table: "session_stars",
    getKey: (row) => row.session_id,
  });

  // Live-only token buffer for in-flight assistant messages. Fed by the SSE
  // stream (transient deltas only); unioned with the durable message row in the
  // transcript live query; cleared when the durable row reaches "completed".
  const transientDeltas = createCollection(
    localOnlyCollectionOptions<TransientDelta>({
      id: `transient_deltas:${workspaceId}`,
      getKey: (row) => row.messageId,
    }),
  );

  return { workspaceId, agents, agentSessions, sessionStars, transientDeltas };
}

export type Collections = ReturnType<typeof createCollections>;

/**
 * Per-session collections, created on demand for the session currently open.
 * The proxy authorizes `session_id` (verifies the session belongs to the
 * caller's workspace/user) before scoping the shape to it.
 */
export function createSessionCollections(workspaceId: string, sessionId: string) {
  const messages = createElectricCollection<AgentSessionMessageRow>({
    id: `agent_session_messages:${workspaceId}:${sessionId}`,
    table: "agent_session_messages",
    params: { session_id: sessionId },
    getKey: (row) => row.id,
  });

  const events = createElectricCollection<AgentSessionEventRow>({
    id: `agent_session_events:${workspaceId}:${sessionId}`,
    table: "agent_session_events",
    params: { session_id: sessionId },
    getKey: (row) => row.id,
  });

  return { sessionId, messages, events };
}

export type SessionCollections = ReturnType<typeof createSessionCollections>;
