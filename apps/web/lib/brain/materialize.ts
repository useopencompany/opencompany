import { getDb } from "@opencompany/db/client";
import { brainFiles, brainSyncJobs, workspaces } from "@opencompany/db/schema";
import { captureException } from "@opencompany/observability";
import { and, eq } from "drizzle-orm";
import { workspaceBrainPath } from "@/lib/brain/paths";
import { endTimingTrace, startTimingTrace, timeAsync } from "@/lib/observability/timing";
import { nextSyncRetryAt } from "@/lib/sync-outbox/retry";
import {
  deleteWorkspaceFile,
  ensureWorkspaceRepository,
  writeWorkspaceFile,
} from "@/lib/workspace-state/github";

export async function materializeBrainFileToGitHub(input: { workspaceId: string; path: string }) {
  const trace = startTimingTrace("brain.materializeToGitHub", {
    workspaceId: input.workspaceId,
    path: input.path,
  });
  const db = getDb();

  const [row] = await timeAsync(trace, "db.selectBrainSyncJob", () =>
    db
      .select({
        workspace: workspaces,
        file: brainFiles,
        job: brainSyncJobs,
      })
      .from(brainSyncJobs)
      .innerJoin(workspaces, eq(brainSyncJobs.workspaceId, workspaces.id))
      .leftJoin(
        brainFiles,
        and(
          eq(brainFiles.workspaceId, brainSyncJobs.workspaceId),
          eq(brainFiles.path, brainSyncJobs.path),
        ),
      )
      .where(
        and(eq(brainSyncJobs.workspaceId, input.workspaceId), eq(brainSyncJobs.path, input.path)),
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

  await timeAsync(trace, "db.markSyncing", () =>
    db
      .update(brainSyncJobs)
      .set({ status: "syncing", lastError: null, updatedAt: new Date() })
      .where(eq(brainSyncJobs.id, row.job.id)),
  );

  try {
    const repository = await timeAsync(trace, "github.ensureRepository", () =>
      ensureWorkspaceRepository({ db, workspace: row.workspace }),
    );

    let commitSha: string | null = null;
    let blobSha: string | null = null;

    if (row.job.operation === "delete") {
      const result = await timeAsync(trace, "github.deleteBrainFile", () =>
        deleteWorkspaceFile({
          db,
          repository,
          path: workspaceBrainPath(row.job.path),
          message: `Delete brain/${row.job.path}`,
          blobSha: row.job.previousBlobSha,
        }),
      );
      commitSha = result.commitSha;
    } else {
      if (!row.file) {
        await db.delete(brainSyncJobs).where(eq(brainSyncJobs.id, row.job.id));
        endTimingTrace(trace, { status: "missing-file" });
        return { status: "missing-file" as const };
      }
      const file = row.file;

      const result = await timeAsync(trace, "github.writeBrainFile", () =>
        writeWorkspaceFile({
          db,
          repository,
          path: workspaceBrainPath(file.path),
          content: file.content,
          message: `Update brain/${file.path}`,
          blobSha: file.githubBlobSha,
        }),
      );
      commitSha = result.commitSha;
      blobSha = result.blobSha;

      if (row.job.previousPath && row.job.previousPath !== file.path) {
        const deleteResult = await timeAsync(trace, "github.deletePreviousBrainFile", () =>
          deleteWorkspaceFile({
            db,
            repository,
            path: workspaceBrainPath(row.job.previousPath!),
            message: `Delete brain/${row.job.previousPath}`,
            blobSha: row.job.previousBlobSha,
          }),
        );
        commitSha = deleteResult.commitSha ?? commitSha;
      }

      await timeAsync(trace, "db.markFileSynced", () =>
        db
          .update(brainFiles)
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
              eq(brainFiles.workspaceId, file.workspaceId),
              eq(brainFiles.path, file.path),
              eq(brainFiles.contentHash, file.contentHash),
            ),
          ),
      );
    }

    await timeAsync(trace, "db.deleteSyncJob", () =>
      db.delete(brainSyncJobs).where(eq(brainSyncJobs.id, row.job.id)),
    );
    endTimingTrace(trace, { status: "synced" });
    return { status: "synced" as const, commitSha, blobSha };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub sync error";
    const failedAttempts = row.job.attempts + 1;
    const now = new Date();
    captureException(error, {
      event: "opencompany.brain_github_sync_failed",
      workspace_id: input.workspaceId,
      path: input.path,
    });
    await db.batch([
      db
        .update(brainFiles)
        .set({ githubSyncStatus: "failed", githubSyncError: message, updatedAt: now })
        .where(and(eq(brainFiles.workspaceId, input.workspaceId), eq(brainFiles.path, input.path))),
      db
        .update(brainSyncJobs)
        .set({
          status: "failed",
          attempts: failedAttempts,
          nextRunAt: nextSyncRetryAt(now, failedAttempts),
          lastError: message,
          updatedAt: now,
        })
        .where(eq(brainSyncJobs.id, row.job.id)),
    ]);
    endTimingTrace(trace, { status: "failed", error: message });
    throw error;
  }
}
