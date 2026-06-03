import { parseAgentFile, serializeAgentFile } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { hashAgentSource } from "@/lib/agents/hash";
import { resolveAgentPath } from "@/lib/agents/paths";

export function newAgentId() {
  const raw = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `agt_${raw}`;
}

export async function nextAvailableAgentPath(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
  title: string,
  currentPath?: string | null,
) {
  const rows = await db
    .select({ path: agents.path })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId));
  return resolveAgentPath({
    title,
    currentPath,
    existingPaths: rows.flatMap((row) => (row.path ? [row.path] : [])),
  });
}

export function buildPendingAgent(input: {
  workspaceId: string;
  title: string;
  body: string;
  path: string;
  id?: string;
  model?: AgentModelId;
  version?: number;
}) {
  const id = input.id ?? newAgentId();
  const version = input.version ?? 1;
  const source = serializeAgentFile({
    title: input.title,
    body: input.body,
    ...(input.model ? { model: input.model } : {}),
  });
  const parsed = parseAgentFile(source);
  const contentHash = hashAgentSource(source);

  return {
    id,
    source,
    contentHash,
    version,
    agent: {
      id,
      workspaceId: input.workspaceId,
      path: input.path,
      name: parsed.title,
      body: parsed.body,
      contentHash,
      version,
      config: parsed.config,
      githubSyncStatus: "pending",
    },
    syncJob: {
      agentId: id,
      workspaceId: input.workspaceId,
      path: input.path,
      desiredHash: contentHash,
      desiredVersion: version,
      previousPath: null,
      previousBlobSha: null,
    },
  };
}
