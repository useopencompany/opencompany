import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { and, desc, eq, or } from "drizzle-orm";
import { cache } from "react";
import { type AgentPayload, serializeAgent } from "@/lib/agents/payload";

export const loadAgentsForWorkspace = cache(
  async (workspaceId: string): Promise<AgentPayload[]> => {
    const db = getDb();
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId))
      .orderBy(desc(agents.updatedAt));

    return rows.map(serializeAgent);
  },
);

export const loadAgentForWorkspace = cache(
  async (workspaceId: string, idOrPath: string): Promise<AgentPayload | null> => {
    const db = getDb();
    const [agent] = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          or(eq(agents.id, idOrPath), eq(agents.path, idOrPath)),
        ),
      )
      .limit(1);

    return agent ? serializeAgent(agent) : null;
  },
);
