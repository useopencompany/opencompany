import { getDb } from "@opencompany/db/client";
import { agents, brainFiles } from "@opencompany/db/schema";
import { and, asc, desc, eq, or } from "drizzle-orm";
import { cache } from "react";
import { type AgentPayload, serializeAgent } from "@/lib/agents/payload";

const loadBrainPathsForWorkspace = cache(async (workspaceId: string): Promise<string[]> => {
  const db = getDb();
  const rows = await db
    .select({ path: brainFiles.path })
    .from(brainFiles)
    .where(eq(brainFiles.workspaceId, workspaceId))
    .orderBy(asc(brainFiles.path));
  return rows.map((row) => row.path);
});

export const loadAgentsForWorkspace = cache(
  async (workspaceId: string): Promise<AgentPayload[]> => {
    const db = getDb();
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId))
      .orderBy(desc(agents.updatedAt));

    return rows.map((row) => serializeAgent(row));
  },
);

export const loadAgentForWorkspace = cache(
  async (workspaceId: string, idOrPath: string): Promise<AgentPayload | null> => {
    const db = getDb();
    const [[agent], brainPaths] = await Promise.all([
      db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            or(eq(agents.id, idOrPath), eq(agents.path, idOrPath)),
          ),
        )
        .limit(1),
      loadBrainPathsForWorkspace(workspaceId),
    ]);

    return agent ? serializeAgent(agent, brainPaths) : null;
  },
);
