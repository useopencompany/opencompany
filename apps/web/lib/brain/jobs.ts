import { BRAIN_SYNC_DELAY_MS } from "@opencompany/agent-runtime";

export { BRAIN_SYNC_DELAY_MS };

// Sticky-first rename resolution: once a pending sync job records the original
// on-disk path, keep it across chained renames within the coalesce window so the
// projector deletes the path that actually exists in the repo, not an
// intermediate that was never committed.
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
