import { getDb } from "@opencompany/db/client";
import { workspaceRepositories, workspaceSyncJobs } from "@opencompany/db/schema";
import { eq, sql } from "drizzle-orm";

export type WorkspaceSyncStatus = {
  /** Whether a backing Git repository has been provisioned yet. */
  hasRepo: boolean;
  /** When the repo last received a projection commit (repo row updatedAt). */
  lastSyncedAt: Date | null;
  /** Changes waiting to project (pending + in-flight). */
  pendingCount: number;
  /** Changes whose last projection attempt failed (will retry). */
  failedCount: number;
};

// Workspace-level GitHub projection status for the settings panel. Deliberately
// minimal: it never returns repo/org names or file paths to the client — only
// counts and a last-synced timestamp. Reads the unified workspace_sync_jobs
// outbox, so "what's pending for this workspace" is a single grouped query.
export async function loadWorkspaceSyncStatus(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
): Promise<WorkspaceSyncStatus> {
  const [repoRows, statusCounts] = await Promise.all([
    db
      .select({ updatedAt: workspaceRepositories.updatedAt })
      .from(workspaceRepositories)
      .where(eq(workspaceRepositories.workspaceId, workspaceId))
      .limit(1),
    db
      .select({
        status: workspaceSyncJobs.status,
        count: sql<number>`count(*)::int`,
      })
      .from(workspaceSyncJobs)
      .where(eq(workspaceSyncJobs.workspaceId, workspaceId))
      .groupBy(workspaceSyncJobs.status),
  ]);

  let pendingCount = 0;
  let failedCount = 0;
  for (const row of statusCounts) {
    if (row.status === "failed") failedCount += Number(row.count);
    else pendingCount += Number(row.count); // "pending" + "syncing"
  }

  return {
    hasRepo: repoRows.length > 0,
    lastSyncedAt: repoRows[0]?.updatedAt ?? null,
    pendingCount,
    failedCount,
  };
}
