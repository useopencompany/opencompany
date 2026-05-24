import { getDb } from "@opencompany/db/client";
import { agentSyncJobs, agents, workspaces } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import { serializeAgentFile } from "@/lib/agents/agent-file";
import { hashAgentSource } from "@/lib/agents/hash";
import { endTimingTrace, startTimingTrace, timeAsync } from "@/lib/observability/timing";
import {
  deleteWorkspaceFile,
  ensureWorkspaceRepository,
  writeWorkspaceFile,
} from "@/lib/workspace-state/github";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

type MaterializeMode = "scheduled" | "force";

export type MaterializeResult =
  | { status: "missing" }
  | { status: "deferred"; nextRunAt: Date }
  | { status: "synced"; commitSha: string | null; blobSha: string | null }
  | { status: "unchanged" }
  | { status: "stale" };

export async function materializeAgentToGitHub(
  agentId: string,
  options: { mode: MaterializeMode } = { mode: "scheduled" },
): Promise<MaterializeResult> {
  const trace = startTimingTrace("agents.materializeToGitHub", {
    mode: options.mode,
  });
  const db = getDb();

  const [row] = await timeAsync(trace, "db.selectAgentForMaterialize", () =>
    db
      .select({
        agent: agents,
        workspace: workspaces,
        job: agentSyncJobs,
      })
      .from(agents)
      .innerJoin(workspaces, eq(agents.workspaceId, workspaces.id))
      .leftJoin(agentSyncJobs, eq(agentSyncJobs.agentId, agents.id))
      .where(eq(agents.id, agentId))
      .limit(1),
  );

  if (!row) {
    endTimingTrace(trace, { status: "missing" });
    return { status: "missing" };
  }

  if (!row.agent.path) {
    endTimingTrace(trace, { status: "missing-path" });
    return { status: "missing" };
  }

  if (
    options.mode === "scheduled" &&
    row.job?.nextRunAt &&
    row.job.nextRunAt.getTime() > Date.now()
  ) {
    endTimingTrace(trace, { status: "deferred", path: row.agent.path });
    return { status: "deferred", nextRunAt: row.job.nextRunAt };
  }

  const source = serializeAgentFile({
    title: row.agent.name,
    body: row.agent.body,
    model: row.agent.config.model.name,
  });
  const contentHash = hashAgentSource(source);
  const pendingRename =
    row.job?.previousPath && row.job.previousPath !== row.agent.path
      ? {
          previousPath: row.job.previousPath,
          previousBlobSha: row.job.previousBlobSha,
        }
      : null;
  const syncStartedAt = Date.now();
  const syncLogFields = {
    agent_id: row.agent.id,
    workspace_id: row.workspace.id,
    path: row.agent.path,
    mode: options.mode,
    desired_hash: contentHash,
    desired_version: row.job?.desiredVersion ?? null,
    attempts: row.job?.attempts ?? 0,
    has_pending_rename: Boolean(pendingRename),
  };

  if (row.agent.githubSyncedHash === contentHash && !pendingRename) {
    await timeAsync(trace, "db.deleteUnchangedSyncJob", () =>
      db
        .delete(agentSyncJobs)
        .where(
          and(eq(agentSyncJobs.agentId, row.agent.id), eq(agentSyncJobs.desiredHash, contentHash)),
        ),
    );
    endTimingTrace(trace, { status: "unchanged", path: row.agent.path });
    return { status: "unchanged" };
  }

  await timeAsync(trace, "db.markSyncing", () =>
    db
      .update(agents)
      .set({
        githubSyncStatus: "syncing",
        githubSyncError: null,
      })
      .where(and(eq(agents.id, row.agent.id), eq(agents.contentHash, contentHash))),
  );
  logger.info("Started agent GitHub sync", {
    event: "opencompany.agent_github_sync_started",
    ...syncLogFields,
  });

  try {
    const repository = await timeAsync(trace, "github.ensureRepository", () =>
      ensureWorkspaceRepository({ db, workspace: row.workspace }),
    );
    const result = await timeAsync(
      trace,
      "github.writeWorkspaceFile",
      () =>
        writeWorkspaceFile({
          db,
          repository,
          path: row.agent.path!,
          content: source,
          message: `Update ${row.agent.path}`,
          blobSha: pendingRename ? null : row.agent.githubBlobSha,
        }),
      { path: row.agent.path },
    );
    const deleteResult = pendingRename
      ? await timeAsync(
          trace,
          "github.deletePreviousWorkspaceFile",
          () =>
            deleteWorkspaceFile({
              db,
              repository,
              path: pendingRename.previousPath,
              message: `Delete ${pendingRename.previousPath}`,
              blobSha: pendingRename.previousBlobSha,
            }),
          { path: pendingRename.previousPath },
        )
      : null;
    const commitSha = deleteResult?.commitSha ?? result.commitSha;

    const now = new Date();
    await timeAsync(trace, "db.markSynced", () =>
      db
        .update(agents)
        .set({
          commitSha,
          githubBlobSha: result.blobSha,
          githubCommitSha: commitSha,
          githubSyncedHash: contentHash,
          githubSyncedAt: now,
          githubSyncStatus: "synced",
          githubSyncError: null,
        })
        .where(and(eq(agents.id, row.agent.id), eq(agents.contentHash, contentHash))),
    );
    await timeAsync(trace, "db.deleteSyncJob", () =>
      db
        .delete(agentSyncJobs)
        .where(
          and(eq(agentSyncJobs.agentId, row.agent.id), eq(agentSyncJobs.desiredHash, contentHash)),
        ),
    );

    const [latest] = await timeAsync(trace, "db.selectLatestAgentHash", () =>
      db
        .select({ contentHash: agents.contentHash })
        .from(agents)
        .where(eq(agents.id, row.agent.id))
        .limit(1),
    );
    const status = latest?.contentHash === contentHash ? "synced" : "stale";
    logger.info("Completed agent GitHub sync", {
      event: "opencompany.agent_github_sync_succeeded",
      ...syncLogFields,
      status,
      commit_sha: commitSha,
      blob_sha: result.blobSha,
      duration_ms: Date.now() - syncStartedAt,
    });
    endTimingTrace(trace, { status, path: row.agent.path });
    return status === "synced"
      ? {
          status,
          commitSha,
          blobSha: result.blobSha,
        }
      : { status };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub sync error";
    captureException(error, {
      event: "opencompany.agent_github_sync_failed",
      workspace_id: row.workspace.id,
      agent_id: row.agent.id,
      path: row.agent.path,
      mode: options.mode,
    });
    logger.error("Failed agent GitHub sync", {
      event: "opencompany.agent_github_sync_failed",
      ...syncLogFields,
      duration_ms: Date.now() - syncStartedAt,
      ...errorLogFields(error),
    });
    await timeAsync(trace, "db.markSyncFailed", () =>
      db
        .update(agents)
        .set({
          githubSyncStatus: "failed",
          githubSyncError: message,
        })
        .where(and(eq(agents.id, row.agent.id), eq(agents.contentHash, contentHash))),
    );
    await timeAsync(trace, "db.recordSyncJobFailure", () =>
      db
        .update(agentSyncJobs)
        .set({
          status: "failed",
          attempts: (row.job?.attempts ?? 0) + 1,
          lastError: message,
          updatedAt: new Date(),
        })
        .where(eq(agentSyncJobs.agentId, row.agent.id)),
    );
    endTimingTrace(trace, {
      status: "failed",
      path: row.agent.path,
      error: message,
    });
    throw error;
  }
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
