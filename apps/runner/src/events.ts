import { EventEmitter } from "node:events";
import type { AgentRuntimeEvent, AgentRuntimeEventPayload } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agentSessionEvents } from "@opencompany/db/schema";
import { and, asc, eq, gt } from "drizzle-orm";

type Db = ReturnType<typeof getDb>;
export type PersistedRuntimeEvent = Awaited<ReturnType<typeof listSessionEvents>>[number];

const sessionEventBroker = new EventEmitter();
sessionEventBroker.setMaxListeners(0);

export async function appendRuntimeEvent(
  db: Db,
  input: {
    sessionId: string;
    messageId?: string | null;
  } & AgentRuntimeEvent,
) {
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
  listener: (event: PersistedRuntimeEvent) => void,
) {
  const eventName = brokerEventName(sessionId);
  sessionEventBroker.on(eventName, listener);
  return () => {
    sessionEventBroker.off(eventName, listener);
  };
}

function publishRuntimeEvent(sessionId: string, event: PersistedRuntimeEvent) {
  sessionEventBroker.emit(brokerEventName(sessionId), event);
}

function brokerEventName(sessionId: string) {
  return `session:${sessionId}`;
}
