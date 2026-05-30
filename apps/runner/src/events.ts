import { EventEmitter } from "node:events";
import type { AgentRuntimeEvent, AgentRuntimeEventPayload } from "@opencompany/agent-runtime";
import { agentSessionEvents } from "@opencompany/db/schema";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { getDb } from "./db";
import { rowsFromExecute } from "./sql-exec";

type Db = ReturnType<typeof getDb>;
type TransientPublishableRuntimeEvent = Extract<
  AgentRuntimeEvent,
  { type: "message.delta" | "message.reasoning_delta" | "command.output" }
>;
export type PersistedRuntimeEvent = Omit<
  Awaited<ReturnType<typeof listSessionEvents>>[number],
  "createdAt"
> & {
  createdAt: Date | string;
};
export type TransientRuntimeEvent = {
  id: null;
  sessionId: string;
  messageId: string | null;
  type: TransientPublishableRuntimeEvent["type"];
  payload: AgentRuntimeEventPayload;
  createdAt: Date;
  transient: true;
};
export type RuntimeEventForStream = PersistedRuntimeEvent | TransientRuntimeEvent;

const sessionEventBroker = new EventEmitter();
sessionEventBroker.setMaxListeners(0);

export async function appendRuntimeEvent(
  db: Db,
  input: {
    sessionId: string;
    messageId?: string | null;
    // When a lease identity is supplied, the row is appended as a single atomic
    // statement that inserts only while that lease is still current — there is no
    // separate check-then-write window. A lost lease yields `null` (the caller treats
    // it as a rejected lease write) rather than an error. Omitting the lease performs
    // an unconditional append and throws if the insert somehow writes nothing.
    leaseId?: string;
    leaseOwner?: string;
  } & AgentRuntimeEvent,
): Promise<PersistedRuntimeEvent | null> {
  if (input.leaseId && input.leaseOwner) {
    const result = await db.execute(sql`
      INSERT INTO agent_session_events (session_id, message_id, type, payload)
      SELECT
        ${input.sessionId},
        ${input.messageId ?? null},
        ${input.type},
        ${JSON.stringify(input.payload)}::jsonb
      WHERE EXISTS (
        SELECT 1
        FROM agent_sessions s
        WHERE s.id = ${input.sessionId}
          AND s.run_lease_id = ${input.leaseId}
          AND s.run_lease_owner = ${input.leaseOwner}
          AND s.archived_at IS NULL
      )
      RETURNING
        id,
        session_id AS "sessionId",
        message_id AS "messageId",
        type,
        payload,
        created_at AS "createdAt"
    `);
    const row = rowsFromExecute<PersistedRuntimeEvent>(result)[0] ?? null;
    // The raw `db.execute` path bypasses Drizzle's column mapping, so `created_at`
    // arrives as the driver's native value — a string under the runner's pg runtime —
    // rather than a Date. Normalize it so the event honors its `createdAt: Date`
    // contract and SSE serialization (`createdAt.toISOString()`) cannot throw.
    const event = row ? { ...row, createdAt: toDate(row.createdAt) } : null;
    if (event) {
      publishRuntimeEvent(input.sessionId, event);
    }
    return event;
  }

  const [event] = await db
    .insert(agentSessionEvents)
    .values({
      sessionId: input.sessionId,
      messageId: input.messageId ?? null,
      type: input.type,
      payload: input.payload as AgentRuntimeEventPayload,
    })
    .returning();

  if (!event) {
    throw new Error("Failed to append runtime event.");
  }

  publishRuntimeEvent(input.sessionId, event);
  return event;
}

export function publishTransientRuntimeEvent(
  input: {
    sessionId: string;
    messageId?: string | null;
  } & TransientPublishableRuntimeEvent,
) {
  const event: TransientRuntimeEvent = {
    id: null,
    sessionId: input.sessionId,
    messageId: input.messageId ?? null,
    type: input.type,
    payload: input.payload as AgentRuntimeEventPayload,
    createdAt: new Date(),
    transient: true,
  };

  publishRuntimeEvent(input.sessionId, event);
  return event;
}

export async function listSessionEvents(input: {
  sessionId: string;
  afterId: number;
  limit?: number;
}) {
  const db = getDb();
  return db
    .select()
    .from(agentSessionEvents)
    .where(
      and(
        eq(agentSessionEvents.sessionId, input.sessionId),
        gt(agentSessionEvents.id, input.afterId),
      ),
    )
    .orderBy(asc(agentSessionEvents.id))
    .limit(input.limit ?? 100);
}

export function subscribeSessionEvents(
  sessionId: string,
  listener: (event: RuntimeEventForStream) => void,
) {
  const eventName = brokerEventName(sessionId);
  sessionEventBroker.on(eventName, listener);
  return () => {
    sessionEventBroker.off(eventName, listener);
  };
}

export function publishRuntimeEvent(sessionId: string, event: RuntimeEventForStream) {
  sessionEventBroker.emit(brokerEventName(sessionId), event);
}

function brokerEventName(sessionId: string) {
  return `session:${sessionId}`;
}

// Raw `db.execute` rows skip Drizzle's value mapping, so a timestamptz can arrive as a
// string. Coerce to Date so callers and serializers can rely on the declared type.
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
