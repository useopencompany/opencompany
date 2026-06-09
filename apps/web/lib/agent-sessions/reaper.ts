import { getDb } from "@opencompany/db/client";
import { agentSessionEvents, agentSessionMessages, agentSessions } from "@opencompany/db/schema";
import { createLogger } from "@opencompany/observability";
import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { appendSessionStreamEvent } from "@/lib/agent-sessions/durable-streams";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

// Run-control leases are refreshed every few seconds while a runner is alive
// (RUN_HEARTBEAT_INTERVAL_MS in apps/runner/src/run-control.ts pushes
// run_lease_expires_at to now + 15min on every heartbeat). An expired lease is
// therefore an unambiguous signal that the owning runner process died — crashed,
// was redeployed, or OOM'd — without finishing its turn, leaving the session
// stranded in `running`/`aborting` forever (nothing else transitions it).
//
// claimRunLease uses the same `run_lease_expires_at < now` predicate to permit a
// fresh turn to reclaim such a lease, so reaping on it can never race a live owner
// or a turn that just reclaimed the session: a live/just-reclaimed lease always has
// its expiry in the future and so falls outside this predicate.
export const ORPHANED_RUN_REAP_CRON = "* * * * *";
export const ORPHANED_RUN_REAP_LIMIT = 100;

// Surfaced in the session error banner and as the assistant message's failure
// reason. Mirrors the runner's own session.error → failRunLease("failed", message)
// path so a reaped turn reconciles identically to a turn the runner failed itself.
export const ORPHANED_RUN_ERROR =
  "Run interrupted: the runner stopped responding and its lease expired. " +
  "The turn was ended automatically — send a message to continue.";

type Db = ReturnType<typeof getDb>;

export type ReapOrphanedRunningSessionsResult = {
  reaped: number;
  sessionIds: string[];
};

/**
 * Fail sessions stuck in an active status whose run lease has expired — the
 * backstop for a runner that died mid-turn. Returns the sessions it flipped.
 *
 * The flip is a single predicate-guarded UPDATE so a concurrent claimRunLease (or a
 * still-alive runner heartbeat) that moves the lease forward wins: such a row no
 * longer satisfies `run_lease_expires_at < now` and is left untouched. RETURNING
 * scopes the follow-up reconciliation (message + event writes) to exactly the rows
 * this sweep owns.
 */
export async function reapOrphanedRunningSessions(
  options: { db?: Db; now?: Date; limit?: number } = {},
): Promise<ReapOrphanedRunningSessionsResult> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const limit = options.limit ?? ORPHANED_RUN_REAP_LIMIT;

  const eligible = and(
    isNull(agentSessions.archivedAt),
    inArray(agentSessions.status, ["running", "aborting"]),
    isNotNull(agentSessions.runLeaseExpiresAt),
    lt(agentSessions.runLeaseExpiresAt, now),
  );

  // Bound the batch via a subquery (UPDATE has no LIMIT); the predicate is repeated
  // on the outer UPDATE so the row is re-checked under Postgres's concurrent-update
  // recheck, not just at subquery-planning time.
  const candidates = db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(eligible)
    .orderBy(asc(agentSessions.runLeaseExpiresAt))
    .limit(limit);

  const reapedRows = await db
    .update(agentSessions)
    .set({
      status: "failed",
      runLeaseId: null,
      runLeaseOwner: null,
      runLeaseMessageId: null,
      runLeaseExpiresAt: null,
      runHeartbeatAt: null,
      lastError: ORPHANED_RUN_ERROR,
      updatedAt: now,
    })
    .where(and(inArray(agentSessions.id, candidates), eligible))
    .returning({ id: agentSessions.id });

  const sessionIds = reapedRows.map((row) => row.id);
  if (sessionIds.length === 0) return { reaped: 0, sessionIds: [] };

  // Settle the orphaned in-flight assistant turn(s). The web payload + the live event
  // reducer already downgrade a `running` assistant message to `failed` once the
  // session is failed, but persisting it keeps the raw DB consistent for any consumer
  // that reads message rows directly (e.g. the cross-session recall index).
  await db
    .update(agentSessionMessages)
    .set({ status: "failed", completedAt: now })
    .where(
      and(
        inArray(agentSessionMessages.sessionId, sessionIds),
        eq(agentSessionMessages.role, "assistant"),
        eq(agentSessionMessages.status, "running"),
      ),
    );

  // Durable failure event so SSE replay (agent_session_events) and live viewers
  // reconcile to failed + surface the error, exactly as the runner's session.error
  // would have. The DB row above is the source of truth; these are reconciliation.
  await db.insert(agentSessionEvents).values(
    sessionIds.map((sessionId) => ({
      sessionId,
      type: "session.error",
      payload: { message: ORPHANED_RUN_ERROR },
    })),
  );

  const createdAt = now.toISOString();
  for (const sessionId of sessionIds) {
    // Best-effort: a slow/unconfigured Durable Streams service must never block or
    // fail the sweep — Postgres remains the system of record.
    try {
      await appendSessionStreamEvent(sessionId, {
        id: null,
        type: "session.error",
        messageId: null,
        payload: { message: ORPHANED_RUN_ERROR },
        createdAt,
      });
    } catch (error) {
      logger.warn("Failed to append reaper failure event to durable stream", {
        event: "opencompany.orphaned_run_reaper_stream_append_failed",
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.warn("Reaped orphaned running sessions with expired run leases", {
    event: "opencompany.orphaned_run_reaped",
    reaped_count: sessionIds.length,
    session_ids: sessionIds,
  });

  return { reaped: sessionIds.length, sessionIds };
}
