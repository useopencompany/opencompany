export function resolveAgentSyncRename(input: {
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
