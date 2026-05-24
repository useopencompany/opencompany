import { getDb } from "@opencompany/db/client";
import { brainSyncJobs } from "@opencompany/db/schema";

type Db = ReturnType<typeof getDb>;

export const BRAIN_SYNC_DELAY_MS = 10_000;

export function resolveBrainSyncRename(input: {
  existingPreviousPath?: string | null | undefined;
  existingPreviousBlobSha?: string | null | undefined;
  renamePreviousPath?: string | null | undefined;
  renamePreviousBlobSha?: string | null | undefined;
}) {
  if (input.existingPreviousPath) {
    return {
      previousPath: input.existingPreviousPath,
      previousBlobSha: input.existingPreviousBlobSha ?? null,
    };
  }

  if (input.renamePreviousPath) {
    return {
      previousPath: input.renamePreviousPath,
      previousBlobSha: input.renamePreviousBlobSha ?? null,
    };
  }

  return {
    previousPath: null,
    previousBlobSha: null,
  };
}

export function brainSyncJobUpsert(
  db: Db,
  input: {
    workspaceId: string;
    path: string;
    operation: "upsert" | "delete";
    desiredHash: string | null;
    previousPath?: string | null;
    previousBlobSha?: string | null;
  },
) {
  const now = new Date();
  const nextRunAt = new Date(now.getTime() + BRAIN_SYNC_DELAY_MS);
  return db
    .insert(brainSyncJobs)
    .values({
      workspaceId: input.workspaceId,
      path: input.path,
      operation: input.operation,
      desiredHash: input.desiredHash,
      previousPath: input.previousPath ?? null,
      previousBlobSha: input.previousBlobSha ?? null,
      nextRunAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [brainSyncJobs.workspaceId, brainSyncJobs.path],
      set: {
        operation: input.operation,
        desiredHash: input.desiredHash,
        previousPath: input.previousPath ?? null,
        previousBlobSha: input.previousBlobSha ?? null,
        status: "pending",
        nextRunAt,
        lastError: null,
        updatedAt: now,
      },
    });
}
