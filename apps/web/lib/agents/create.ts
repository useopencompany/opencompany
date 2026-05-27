import { parseAgentFile, serializeAgentFile } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import { agentSyncJobs, agents } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { eq } from "drizzle-orm";
import { after } from "next/server";
import { hashAgentSource } from "@/lib/agents/hash";
import { resolveAgentPath } from "@/lib/agents/paths";
import { dispatchAgentSyncRequested } from "@/lib/agents/sync-events";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });
const AGENT_SYNC_DISPATCH_DELAY_MS = 10_000;

type AgentSyncJobInput = {
  agentId: string;
  workspaceId: string;
  path: string;
  desiredHash: string;
  desiredVersion: number;
  previousPath: string | null;
  previousBlobSha: string | null;
};

type AgentSyncJobQueueMetadata = {
  agent_id: string;
  workspace_id: string;
  path: string;
  desired_hash: string;
  desired_version: number;
  next_run_at: string;
  has_previous_path: boolean;
  has_previous_blob_sha: boolean;
};

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

export function prepareAgentSyncJobUpsert(
  db: Pick<ReturnType<typeof getDb>, "insert">,
  input: AgentSyncJobInput,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const nextRunAt = new Date(now.getTime() + AGENT_SYNC_DISPATCH_DELAY_MS);
  const query = db
    .insert(agentSyncJobs)
    .values({
      ...input,
      status: "pending",
      attempts: 0,
      nextRunAt,
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
        nextRunAt,
        lastError: null,
        updatedAt: now,
      },
    });

  return {
    query,
    metadata: {
      agent_id: input.agentId,
      workspace_id: input.workspaceId,
      path: input.path,
      desired_hash: input.desiredHash,
      desired_version: input.desiredVersion,
      next_run_at: nextRunAt.toISOString(),
      has_previous_path: Boolean(input.previousPath),
      has_previous_blob_sha: Boolean(input.previousBlobSha),
    },
  };
}

export function logAgentSyncJobQueued(metadata: AgentSyncJobQueueMetadata) {
  logger.info("Queued agent GitHub sync job", {
    event: "opencompany.agent_sync_job_queued",
    ...metadata,
  });
}

export function scheduleAgentSyncDispatch(input: {
  id: string;
  workspaceId: string;
  path?: string | null;
}) {
  after(async () => {
    try {
      const result = await dispatchAgentSyncRequested({
        agentId: input.id,
        workspaceId: input.workspaceId,
      });
      logger.info("Dispatched agent GitHub sync event", {
        event: "opencompany.agent_sync_dispatch_succeeded",
        agent_id: input.id,
        workspace_id: input.workspaceId,
        path: input.path ?? null,
        inngest_event_ids: result.ids,
      });
    } catch (error) {
      captureException(error, {
        event: "opencompany.agent_sync_dispatch_failed",
        agent_id: input.id,
        workspace_id: input.workspaceId,
        path: input.path ?? null,
        dispatch_status_marked_failed: false,
      });
      logger.error("Failed to dispatch agent GitHub sync event", {
        event: "opencompany.agent_sync_dispatch_failed",
        agent_id: input.id,
        workspace_id: input.workspaceId,
        path: input.path ?? null,
        dispatch_status_marked_failed: false,
        ...errorLogFields(error),
      });
    }
  });
}

function errorLogFields(error: unknown) {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
    };
  }

  return {
    error_name: typeof error,
    error_message: typeof error === "string" ? error : "Unknown error",
  };
}
