import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { agentEditLocks } from "@opencompany/db/schema";
import { and, eq, gt, sql } from "drizzle-orm";

const AGENT_EDIT_LOCK_LEASE_MS = 75_000;

type ExecuteResultRow = Record<string, unknown>;

type AgentEditLockOwner = {
  id: string;
  name: string;
  email: string;
};

type AgentEditLockRow = {
  agentId: string;
  userId: string;
  token: string;
  expiresAt: Date | string;
  email: string;
  firstName: string | null;
  lastName: string | null;
};

export type AgentEditLockResult =
  | {
      status: "acquired";
      token: string;
      expiresAt: string;
      owner: AgentEditLockOwner;
    }
  | {
      status: "locked";
      expiresAt: string;
      owner: AgentEditLockOwner;
    }
  | { status: "not_found" };

function rowsFromExecute<T extends ExecuteResultRow>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

function nextExpiresAt() {
  return new Date(Date.now() + AGENT_EDIT_LOCK_LEASE_MS);
}

function serializeLockOwner(
  row: Pick<AgentEditLockRow, "userId" | "email" | "firstName" | "lastName">,
) {
  const name = [row.firstName, row.lastName].filter(Boolean).join(" ").trim() || row.email;
  return {
    id: row.userId,
    name,
    email: row.email,
  };
}

function serializeAcquiredLock(row: AgentEditLockRow): AgentEditLockResult {
  return {
    status: "acquired",
    token: row.token,
    expiresAt: new Date(row.expiresAt).toISOString(),
    owner: serializeLockOwner(row),
  };
}

function serializeLockedLock(row: AgentEditLockRow): AgentEditLockResult {
  return {
    status: "locked",
    expiresAt: new Date(row.expiresAt).toISOString(),
    owner: serializeLockOwner(row),
  };
}

async function loadActiveLock(input: { agentId: string; workspaceId: string }) {
  const result = await getDb().execute(sql`
    SELECT
      agent_edit_locks.agent_id AS "agentId",
      agent_edit_locks.user_id AS "userId",
      agent_edit_locks.token AS "token",
      agent_edit_locks.expires_at AS "expiresAt",
      users.email AS "email",
      users.first_name AS "firstName",
      users.last_name AS "lastName"
    FROM agent_edit_locks
    INNER JOIN users ON users.id = agent_edit_locks.user_id
    WHERE agent_edit_locks.agent_id = ${input.agentId}
      AND agent_edit_locks.workspace_id = ${input.workspaceId}
      AND agent_edit_locks.expires_at > now()
    LIMIT 1
  `);

  return rowsFromExecute<AgentEditLockRow>(result)[0] ?? null;
}

export async function acquireAgentEditLockForWorkspace(input: {
  agentId: string;
  workspaceId: string;
  userId: string;
}): Promise<AgentEditLockResult> {
  const token = randomUUID();
  const expiresAt = nextExpiresAt();
  const result = await getDb().execute(sql`
    WITH upsert AS (
      INSERT INTO agent_edit_locks (
        agent_id,
        workspace_id,
        user_id,
        token,
        expires_at,
        updated_at
      )
      SELECT
        ${input.agentId},
        ${input.workspaceId},
        ${input.userId},
        ${token},
        ${expiresAt},
        now()
      WHERE EXISTS (
        SELECT 1 FROM agents
        WHERE agents.id = ${input.agentId}
          AND agents.workspace_id = ${input.workspaceId}
      )
      ON CONFLICT (agent_id) DO UPDATE
      SET user_id = excluded.user_id,
          token = CASE
            WHEN agent_edit_locks.user_id = ${input.userId}
              AND agent_edit_locks.expires_at > now()
            THEN agent_edit_locks.token
            ELSE excluded.token
          END,
          expires_at = excluded.expires_at,
          updated_at = now()
      WHERE agent_edit_locks.workspace_id = ${input.workspaceId}
        AND (
          agent_edit_locks.expires_at <= now()
          OR agent_edit_locks.user_id = ${input.userId}
        )
      RETURNING agent_id, user_id, token, expires_at
    )
    SELECT
      upsert.agent_id AS "agentId",
      upsert.user_id AS "userId",
      upsert.token AS "token",
      upsert.expires_at AS "expiresAt",
      users.email AS "email",
      users.first_name AS "firstName",
      users.last_name AS "lastName"
    FROM upsert
    INNER JOIN users ON users.id = upsert.user_id
  `);

  const acquired = rowsFromExecute<AgentEditLockRow>(result)[0];
  if (acquired) return serializeAcquiredLock(acquired);

  const active = await loadActiveLock(input);
  return active ? serializeLockedLock(active) : { status: "not_found" };
}

export async function refreshAgentEditLockForWorkspace(input: {
  agentId: string;
  workspaceId: string;
  userId: string;
  token: string;
}): Promise<AgentEditLockResult> {
  const expiresAt = nextExpiresAt();
  const result = await getDb().execute(sql`
    WITH refreshed AS (
      UPDATE agent_edit_locks
      SET expires_at = ${expiresAt},
          updated_at = now()
      WHERE agent_id = ${input.agentId}
        AND workspace_id = ${input.workspaceId}
        AND user_id = ${input.userId}
        AND token = ${input.token}
      RETURNING agent_id, user_id, token, expires_at
    )
    SELECT
      refreshed.agent_id AS "agentId",
      refreshed.user_id AS "userId",
      refreshed.token AS "token",
      refreshed.expires_at AS "expiresAt",
      users.email AS "email",
      users.first_name AS "firstName",
      users.last_name AS "lastName"
    FROM refreshed
    INNER JOIN users ON users.id = refreshed.user_id
  `);

  const refreshed = rowsFromExecute<AgentEditLockRow>(result)[0];
  if (refreshed) return serializeAcquiredLock(refreshed);

  const active = await loadActiveLock(input);
  return active ? serializeLockedLock(active) : { status: "not_found" };
}

export async function releaseAgentEditLockForWorkspace(input: {
  agentId: string;
  workspaceId: string;
  userId: string;
  token: string;
}) {
  await getDb()
    .delete(agentEditLocks)
    .where(
      and(
        eq(agentEditLocks.agentId, input.agentId),
        eq(agentEditLocks.workspaceId, input.workspaceId),
        eq(agentEditLocks.userId, input.userId),
        eq(agentEditLocks.token, input.token),
      ),
    );
}

export async function assertValidAgentEditLock(input: {
  agentId: string;
  workspaceId: string;
  userId: string;
  token?: string | undefined;
}) {
  if (!input.token) {
    throw new Error("Agent edit lock is required. Refresh the agent and try again.");
  }

  const [lock] = await getDb()
    .update(agentEditLocks)
    .set({ expiresAt: nextExpiresAt(), updatedAt: new Date() })
    .where(
      and(
        eq(agentEditLocks.agentId, input.agentId),
        eq(agentEditLocks.workspaceId, input.workspaceId),
        eq(agentEditLocks.userId, input.userId),
        eq(agentEditLocks.token, input.token),
        gt(agentEditLocks.expiresAt, new Date()),
      ),
    )
    .returning({ agentId: agentEditLocks.agentId });

  if (!lock) {
    throw new Error("Another editor has this agent open. Refresh the agent and try again.");
  }
}
