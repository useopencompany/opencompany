import { agentSessionEvents } from "@opencompany/db/schema";
import { sql } from "drizzle-orm";
import { type ActiveRunSnapshot, abortActiveRun, listActiveRuns } from "./active-runs";
import { getDb } from "./db";
import { type PersistedRuntimeEvent, publishRuntimeEvent } from "./events";
import { STALE_RUN_HEARTBEAT_MS } from "./run-control";
import { rowsFromExecute } from "./sql-exec";

export type SessionInterruptReason = "runner_shutdown" | "stale_heartbeat";

type PersistedRuntimeEventRow = Omit<PersistedRuntimeEvent, "createdAt"> & {
  createdAt: Date | string;
};
type InterruptedRunRow = {
  sessionId: string;
  leaseId: string;
  leaseOwner: string;
};

export async function interruptCurrentRun(
  input: ActiveRunSnapshot & { reason: SessionInterruptReason },
) {
  const events = await interruptRunSql(input);
  publishEvents(events);
  return events.length > 0;
}

export async function interruptActiveRuns(reason: SessionInterruptReason = "runner_shutdown") {
  const runs = listActiveRuns();
  const results = await Promise.allSettled(
    runs.map(async (run) => {
      try {
        return await interruptCurrentRun({ ...run, reason });
      } finally {
        abortActiveRun(run.sessionId);
      }
    }),
  );
  return results.filter((result) => result.status === "fulfilled" && result.value).length;
}

export async function interruptStaleActiveRuns(now: Date = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_RUN_HEARTBEAT_MS);
  const events = await interruptStaleRunsSql({ staleBefore, reason: "stale_heartbeat" });
  publishEvents(events);
  return countInterruptedSessions(events);
}

async function interruptRunSql(input: ActiveRunSnapshot & { reason: SessionInterruptReason }) {
  const statusPayload = JSON.stringify({ status: "interrupted" });
  const auditPayload = JSON.stringify({
    reason: input.reason,
    leaseId: input.leaseId,
    leaseOwner: input.leaseOwner,
  });

  const result = await getDb().execute(sql`
    WITH updated AS (
      UPDATE agent_sessions
      SET status = 'interrupted',
          run_lease_id = NULL,
          run_lease_owner = NULL,
          run_lease_message_id = NULL,
          run_lease_expires_at = NULL,
          run_heartbeat_at = NULL,
          abort_requested_at = NULL,
          last_error = NULL,
          updated_at = now()
      WHERE id = ${input.sessionId}
        AND run_lease_id = ${input.leaseId}
        AND run_lease_owner = ${input.leaseOwner}
        AND archived_at IS NULL
      RETURNING id
    ),
    status_events AS (
      INSERT INTO agent_session_events (session_id, message_id, type, payload)
      SELECT id, NULL, 'session.status', ${statusPayload}::jsonb
      FROM updated
      RETURNING id, session_id AS "sessionId", message_id AS "messageId", type, payload, created_at AS "createdAt"
    ),
    audit_events AS (
      INSERT INTO agent_session_events (session_id, message_id, type, payload)
      SELECT id, NULL, 'session.interrupted', ${auditPayload}::jsonb
      FROM updated
      RETURNING id, session_id AS "sessionId", message_id AS "messageId", type, payload, created_at AS "createdAt"
    )
    SELECT * FROM status_events
    UNION ALL
    SELECT * FROM audit_events
  `);

  return normalizeRows(rowsFromExecute<PersistedRuntimeEventRow>(result));
}

async function interruptStaleRunsSql(input: { staleBefore: Date; reason: SessionInterruptReason }) {
  return getDb().transaction(async (tx) => {
    const updatedResult = await tx.execute(sql`
      WITH candidates AS (
        SELECT id, run_lease_id AS "leaseId", run_lease_owner AS "leaseOwner"
        FROM agent_sessions
        WHERE status = 'running'
          AND archived_at IS NULL
          AND run_lease_id IS NOT NULL
          AND run_lease_owner IS NOT NULL
          AND run_heartbeat_at IS NOT NULL
          AND run_heartbeat_at < ${input.staleBefore}
      )
      UPDATE agent_sessions AS session
      SET status = 'interrupted',
          run_lease_id = NULL,
          run_lease_owner = NULL,
          run_lease_message_id = NULL,
          run_lease_expires_at = NULL,
          run_heartbeat_at = NULL,
          abort_requested_at = NULL,
          last_error = NULL,
          updated_at = now()
      FROM candidates
      WHERE session.id = candidates.id
        -- Re-checked on the post-lock row version: during a deploy the old and new
        -- instances both run this sweep, and without this guard the loser of the row
        -- lock would re-apply the update and emit duplicate interruption events.
        AND session.status = 'running'
      RETURNING
        session.id AS "sessionId",
        candidates."leaseId",
        candidates."leaseOwner"
    `);
    const interrupted = rowsFromExecute<InterruptedRunRow>(updatedResult);
    if (interrupted.length === 0) return [];

    return tx
      .insert(agentSessionEvents)
      .values(
        interrupted.flatMap((run) => [
          {
            sessionId: run.sessionId,
            messageId: null,
            type: "session.status",
            payload: { status: "interrupted" },
          },
          {
            sessionId: run.sessionId,
            messageId: null,
            type: "session.interrupted",
            payload: {
              reason: input.reason,
              leaseId: run.leaseId,
              leaseOwner: run.leaseOwner,
            },
          },
        ]),
      )
      .returning();
  });
}

function publishEvents(events: PersistedRuntimeEvent[]) {
  for (const event of events) {
    publishRuntimeEvent(event.sessionId, event);
  }
}

function countInterruptedSessions(events: PersistedRuntimeEvent[]) {
  return new Set(
    events.filter((event) => event.type === "session.status").map((event) => event.sessionId),
  ).size;
}

function normalizeRows(rows: PersistedRuntimeEventRow[]): PersistedRuntimeEvent[] {
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  }));
}
