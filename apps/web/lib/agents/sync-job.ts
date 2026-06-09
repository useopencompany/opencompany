import { getDb } from "@opencompany/db/client";
import { enqueueWorkspaceSync } from "@opencompany/db/sync-outbox";

type Db = ReturnType<typeof getDb>;

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

// Enqueues an agent bundle file (user.md, etc.) into the unified workspace
// projection outbox. `path` is the full repo path (agents/<slug>/...).
export function agentFileSyncJobUpsert(
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
  return enqueueWorkspaceSync(db, {
    workspaceId: input.workspaceId,
    repoPath: input.path,
    sourceKind: "agent_file",
    operation: input.operation,
    desiredHash: input.desiredHash,
    previousPath: input.previousPath ?? null,
    previousBlobSha: input.previousBlobSha ?? null,
  });
}

export function agentBundleConflictPath(path: string) {
  const dot = path.lastIndexOf(".");
  // Random (not timestamp) suffix so concurrent conflicts in the same
  // millisecond don't collide and the retry loop in prepareAgentBundleFileMoves
  // produces a distinct path each iteration.
  const suffix = `.conflict-${crypto.randomUUID().slice(0, 8)}`;
  if (dot <= 0) return `${path}${suffix}`;
  return `${path.slice(0, dot)}${suffix}${path.slice(dot)}`;
}

export function isPathInsideAgentBundle(path: string, bundleDir: string) {
  return path.startsWith(`${bundleDir}/`);
}

export type AgentBundleFileMoveInput = {
  files: Array<{
    id: number;
    path: string;
    contentHash: string;
    githubBlobSha: string | null;
  }>;
  existingFileSyncJobs: Array<{
    path: string;
    previousPath: string | null;
    previousBlobSha: string | null;
  }>;
  oldBundleDir: string;
  newBundleDir: string;
};

export function prepareAgentBundleFileMoves(input: AgentBundleFileMoveInput) {
  const movingFiles = input.files.filter((file) =>
    isPathInsideAgentBundle(file.path, input.oldBundleDir),
  );
  const movingPaths = new Set(movingFiles.map((file) => file.path));
  const existingPaths = new Set(input.files.map((file) => file.path));
  const reservedPaths = new Set<string>();
  const jobByPath = new Map(input.existingFileSyncJobs.map((job) => [job.path, job]));

  return movingFiles.map((file) => {
    const relativePath = file.path.slice(input.oldBundleDir.length + 1);
    let path = `${input.newBundleDir}/${relativePath}`;
    // `isPathInsideAgentBundle` is a string prefix check, so reject any `..`
    // segment explicitly — otherwise a malformed path like
    // "agents/sales/../../etc/passwd" would slip past as it still starts with
    // the destination prefix.
    if (
      relativePath.split("/").includes("..") ||
      !isPathInsideAgentBundle(path, input.newBundleDir)
    ) {
      throw new Error("Agent bundle move escaped the destination bundle.");
    }

    while (reservedPaths.has(path) || (existingPaths.has(path) && !movingPaths.has(path))) {
      path = agentBundleConflictPath(path);
    }
    reservedPaths.add(path);

    const existingRenameJob = jobByPath.get(file.path);
    const rename = resolveAgentSyncRename({
      existingPreviousPath: existingRenameJob?.previousPath,
      existingPreviousBlobSha: existingRenameJob?.previousBlobSha,
      renamePreviousPath: file.path,
      renamePreviousBlobSha: file.githubBlobSha,
    });

    return {
      fileId: file.id,
      previousPath: file.path,
      path,
      contentHash: file.contentHash,
      rename,
    };
  });
}
