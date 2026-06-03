import { createHash, randomUUID } from "node:crypto";
import { workspaceSyncJobs } from "@opencompany/db/schema";
import { getDb } from "./db";

export function hashContent(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function conflictPath(path: string) {
  const dot = path.lastIndexOf(".");
  // Random (not timestamp) suffix so concurrent conflicts can't collide.
  const suffix = `.conflict-${randomUUID().slice(0, 8)}`;
  if (dot <= 0) return `${path}${suffix}`;
  return `${path.slice(0, dot)}${suffix}${path.slice(dot)}`;
}

/**
 * Mark a workspace's GitHub mirror as needing a reconcile. The runner writes the
 * authoritative DB rows (brain/agent bundle files the agent edited in its
 * sandbox) and then flags the workspace dirty; the web app's per-workspace
 * reconcile (driven by the workspace-sync outbox sweeper) materializes the whole
 * desired tree to GitHub in a single commit. The runner never writes to GitHub
 * directly. Idempotent: many file writes in one post-session sync collapse into
 * one dirty row.
 */
export async function markWorkspaceDirty(workspaceId: string) {
  const now = new Date();
  await getDb()
    .insert(workspaceSyncJobs)
    .values({
      workspaceId,
      status: "pending",
      attempts: 0,
      nextRunAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workspaceSyncJobs.workspaceId,
      set: {
        status: "pending",
        attempts: 0,
        nextRunAt: now,
        lastError: null,
        updatedAt: now,
      },
    });
}
