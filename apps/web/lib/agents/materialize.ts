import { serializeAgentFile } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  agentFileSyncJobs,
  agentFiles,
  agentSyncJobs,
  agents,
  workspaces,
} from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import { hashAgentSource } from "@/lib/agents/hash";
import { normalizeAgentConfig } from "@/lib/agents/payload";
import { endTimingTrace, startTimingTrace, timeAsync } from "@/lib/observability/timing";
import { nextSyncRetryAt } from "@/lib/sync-outbox/retry";
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

export async function materializeAgentFileToGitHub(input: { workspaceId: string; path: string }) {
  const trace = startTimingTrace("agentFiles.materializeToGitHub", {
    workspaceId: input.workspaceId,
    path: input.path,
  });
  const db = getDb();

  const [row] = await timeAsync(trace, "db.selectAgentFileSyncJob", () =>
    db
      .select({
        workspace: workspaces,
        file: agentFiles,
        job: agentFileSyncJobs,
      })
      .from(agentFileSyncJobs)
      .innerJoin(workspaces, eq(agentFileSyncJobs.workspaceId, workspaces.id))
      .leftJoin(
        agentFiles,
        and(
          eq(agentFiles.workspaceId, agentFileSyncJobs.workspaceId),
          eq(agentFiles.path, agentFileSyncJobs.path),
        ),
      )
      .where(
        and(
          eq(agentFileSyncJobs.workspaceId, input.workspaceId),
          eq(agentFileSyncJobs.path, input.path),
        ),
      )
      .limit(1),
  );

  if (!row?.job) {
    endTimingTrace(trace, { status: "missing" });
    return { status: "missing" as const };
  }

  if (row.job.nextRunAt.getTime() > Date.now()) {
    endTimingTrace(trace, { status: "deferred" });
    return { status: "deferred" as const, nextRunAt: row.job.nextRunAt };
  }

  await timeAsync(trace, "db.markAgentFileSyncing", () =>
    db
      .update(agentFileSyncJobs)
      .set({ status: "syncing", lastError: null, updatedAt: new Date() })
      .where(eq(agentFileSyncJobs.id, row.job.id)),
  );

  try {
    const repository = await timeAsync(trace, "github.ensureRepository", () =>
      ensureWorkspaceRepository({ db, workspace: row.workspace }),
    );

    let commitSha: string | null = null;
    let blobSha: string | null = null;

    if (row.job.operation === "delete") {
      const result = await timeAsync(trace, "github.deleteAgentFile", () =>
        deleteWorkspaceFile({
          db,
          repository,
          path: row.job.path,
          message: `Delete ${row.job.path}`,
          blobSha: row.job.previousBlobSha,
        }),
      );
      commitSha = result.commitSha;
    } else {
      // Upsert jobs normally have a corresponding agentFiles row. If the file
      // was deleted between job creation and execution (a race), there is
      // nothing to write — drop the now-orphaned job. This is expected cleanup,
      // not an error condition.
      if (!row.file) {
        await db.delete(agentFileSyncJobs).where(eq(agentFileSyncJobs.id, row.job.id));
        endTimingTrace(trace, { status: "missing-file" });
        return { status: "missing-file" as const };
      }

      const file = row.file;
      const result = await timeAsync(trace, "github.writeAgentFile", () =>
        writeWorkspaceFile({
          db,
          repository,
          path: file.path,
          content: file.content,
          message: `Update ${file.path}`,
          blobSha: file.githubBlobSha,
        }),
      );
      commitSha = result.commitSha;
      blobSha = result.blobSha;

      if (row.job.previousPath && row.job.previousPath !== file.path) {
        const deleteResult = await timeAsync(trace, "github.deletePreviousAgentFile", () =>
          deleteWorkspaceFile({
            db,
            repository,
            path: row.job.previousPath!,
            message: `Delete ${row.job.previousPath}`,
            blobSha: row.job.previousBlobSha,
          }),
        );
        commitSha = deleteResult.commitSha ?? commitSha;
      }

      await timeAsync(trace, "db.markAgentFileSynced", () =>
        db
          .update(agentFiles)
          .set({
            githubBlobSha: blobSha,
            githubCommitSha: commitSha,
            githubSyncedHash: file.contentHash,
            githubSyncedAt: new Date(),
            githubSyncStatus: "synced",
            githubSyncError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agentFiles.workspaceId, file.workspaceId),
              eq(agentFiles.path, file.path),
              eq(agentFiles.contentHash, file.contentHash),
            ),
          ),
      );
    }

    await timeAsync(trace, "db.deleteAgentFileSyncJob", () =>
      db.delete(agentFileSyncJobs).where(eq(agentFileSyncJobs.id, row.job.id)),
    );
    endTimingTrace(trace, { status: "synced" });
    return { status: "synced" as const, commitSha, blobSha };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub sync error";
    const failedAttempts = row.job.attempts + 1;
    const now = new Date();
    captureException(error, {
      event: "opencompany.agent_file_github_sync_failed",
      workspace_id: input.workspaceId,
      path: input.path,
    });
    await db.batch([
      // If the file was deleted/replaced between sync start and this error, the
      // update matches zero rows. That is acceptable: the replacement file
      // carries its own sync job, so we don't treat a no-op here as a failure.
      db
        .update(agentFiles)
        .set({
          githubSyncStatus: "failed",
          githubSyncError: message,
          updatedAt: now,
        })
        .where(and(eq(agentFiles.workspaceId, input.workspaceId), eq(agentFiles.path, input.path))),
      db
        .update(agentFileSyncJobs)
        .set({
          status: "failed",
          attempts: failedAttempts,
          nextRunAt: nextSyncRetryAt(now, failedAttempts),
          lastError: message,
          updatedAt: now,
        })
        .where(eq(agentFileSyncJobs.id, row.job.id)),
    ]);
    endTimingTrace(trace, { status: "failed", error: message });
    throw error;
  }
}

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

  const config = normalizeAgentConfig(row.agent.config);
  const source = serializeAgentFile({
    title: row.agent.name,
    body: row.agent.body,
    model: config.model.name,
    tools: config.tools,
    brain: config.brain,
    skills: config.skills ?? [],
    integrations: config.integrations,
    triggers: config.triggers,
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
    const failedAttempts = (row.job?.attempts ?? 0) + 1;
    const now = new Date();
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
          attempts: failedAttempts,
          nextRunAt: nextSyncRetryAt(now, failedAttempts),
          lastError: message,
          updatedAt: now,
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
