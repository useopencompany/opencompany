import type { AgentRuntimeEvent, AgentRuntimeEventPayload } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agentSessionEvents } from "@opencompany/db/schema";
import { and, asc, eq, gt } from "drizzle-orm";

type Db = ReturnType<typeof getDb>;

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
