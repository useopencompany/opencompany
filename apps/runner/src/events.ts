import { EventEmitter } from "node:events";
import type { AgentRuntimeEvent, AgentRuntimeEventPayload } from "@opencompany/agent-runtime";
import { agentSessionEvents } from "@opencompany/db/schema";
import { and, asc, eq, gt } from "drizzle-orm";
import { getDb } from "./db";

type Db = ReturnType<typeof getDb>;
type TransientPublishableRuntimeEvent = Extract<
  AgentRuntimeEvent,
  { type: "message.delta" | "message.reasoning_delta" | "command.output" }
>;
export type PersistedRuntimeEvent = Awaited<ReturnType<typeof listSessionEvents>>[number];
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

function publishRuntimeEvent(sessionId: string, event: RuntimeEventForStream) {
  sessionEventBroker.emit(brokerEventName(sessionId), event);
}

function brokerEventName(sessionId: string) {
  return `session:${sessionId}`;
}
