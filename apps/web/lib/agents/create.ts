import { getDb } from "@opencompany/db/client";
import { agentSyncJobs, agents } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { eq } from "drizzle-orm";
import { after } from "next/server";
import { parseAgentFile, serializeAgentFile } from "@/lib/agents/agent-file";
import { hashAgentSource } from "@/lib/agents/hash";
import { resolveAgentPath } from "@/lib/agents/paths";
import { dispatchAgentSyncRequested } from "@/lib/agents/sync-events";
import type { AgentModelId } from "@/lib/agents/types";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

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

export function agentSyncJobUpsert(
  db: Pick<ReturnType<typeof getDb>, "insert">,
  input: {
    agentId: string;
    workspaceId: string;
    path: string;
    desiredHash: string;
    desiredVersion: number;
    previousPath: string | null;
    previousBlobSha: string | null;
  },
) {
  const now = new Date();
  return db
    .insert(agentSyncJobs)
    .values({
      ...input,
      status: "pending",
      attempts: 0,
      nextRunAt: new Date(now.getTime() + 10_000),
      lastError: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: agentSyncJobs.agentId,
      set: {
        path: input.path,
        desiredHash: input.desiredHash,
        desiredVersion: input.desiredVersion,
        previousPath: input.previousPath,
        previousBlobSha: input.previousBlobSha,
        status: "pending",
        attempts: 0,
        nextRunAt: new Date(now.getTime() + 10_000),
        lastError: null,
        updatedAt: now,
      },
    });
}

export function scheduleAgentSyncDispatch(input: { id: string; workspaceId: string }) {
  after(async () => {
    try {
      await dispatchAgentSyncRequested({
        agentId: input.id,
        workspaceId: input.workspaceId,
      });
    } catch (error) {
      captureException(error, {
        event: "opencompany.agent_sync_dispatch_failed",
        agent_id: input.id,
        workspace_id: input.workspaceId,
      });
      logger.error("Failed to dispatch agent GitHub sync event", {
        event: "opencompany.agent_sync_dispatch_failed",
        agent_id: input.id,
        workspace_id: input.workspaceId,
        error,
      });
    }
  });
}
