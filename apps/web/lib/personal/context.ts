import { getDb } from "@opencompany/db/client";
import { agentFiles } from "@opencompany/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { type AgentBundleFilePayload, serializeAgentBundleFiles } from "@/lib/agents/bundle-files";

// The personal agent's "context" is its agent bundle: the files materialized under
// `agents/<slug>/` (memory.md, skills, attachments). They live in the agent_files table
// scoped to (workspaceId, agentId). The agent definition file itself is excluded by
// serializeAgentBundleFiles — it's surfaced separately as the always-present AGENTS.md row.
export async function loadPersonalAgentContextFiles(
  workspaceId: string,
  agentId: string,
  agentPath: string | null,
): Promise<AgentBundleFilePayload[]> {
  if (!agentPath) return [];

  const db = getDb();
  const rows = await db
    .select()
    .from(agentFiles)
    .where(and(eq(agentFiles.workspaceId, workspaceId), eq(agentFiles.agentId, agentId)))
    .orderBy(asc(agentFiles.path));

  return serializeAgentBundleFiles(agentPath, rows);
}
