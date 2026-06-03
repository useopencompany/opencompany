import type { getDb } from "@opencompany/db/client";
import { workspaceSyncJobs } from "@opencompany/db/schema";

type Db = ReturnType<typeof getDb>;

// How long to wait after the last edit before reconciling, so a burst of edits
// collapses into a single commit. Matches the previous per-file coalesce window.
export const WORKSPACE_SYNC_COALESCE_MS = 10_000;

/**
 * Mark a workspace's GitHub mirror as dirty (needs reconciling). Idempotent:
 * repeated calls just push the coalesce window forward and reset retry state,
 * so a burst of edits results in one reconcile.
 */
export function markWorkspaceDirty(db: Db, workspaceId: string) {
  const now = new Date();
  const nextRunAt = new Date(now.getTime() + WORKSPACE_SYNC_COALESCE_MS);
  return db
    .insert(workspaceSyncJobs)
    .values({
      workspaceId,
      status: "pending",
      attempts: 0,
      nextRunAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceSyncJobs.workspaceId,
      set: {
        status: "pending",
        attempts: 0,
        nextRunAt,
        lastError: null,
        updatedAt: now,
      },
    });
}
