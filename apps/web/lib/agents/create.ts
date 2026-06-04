import { parseAgentFile, serializeAgentFile } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import { agents } from "@opencompany/db/schema";
import { enqueueWorkspaceSync } from "@opencompany/db/sync-outbox";
import { createLogger } from "@opencompany/observability";
import { eq } from "drizzle-orm";
import { hashAgentSource } from "@/lib/agents/hash";
import { resolveAgentPath } from "@/lib/agents/paths";

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

// Enqueues the agent .agent definition into the unified workspace projection
// outbox. The agent is identified by sourceRef (agentId) because its repo path
// can change within a coalesce window; the projector re-serializes from the
// agents row at projection time.
export function prepareAgentSyncJobUpsert(
  db: ReturnType<typeof getDb>,
  input: AgentSyncJobInput,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const nextRunAt = new Date(now.getTime() + AGENT_SYNC_DISPATCH_DELAY_MS);
  const query = enqueueWorkspaceSync(db, {
    workspaceId: input.workspaceId,
    repoPath: input.path,
    sourceKind: "agent",
    sourceRef: input.agentId,
    operation: "upsert",
    desiredHash: input.desiredHash,
    previousPath: input.previousPath,
    previousBlobSha: input.previousBlobSha,
    delayMs: AGENT_SYNC_DISPATCH_DELAY_MS,
    now,
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
