import { BRAIN_SYNC_DELAY_MS } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { agentFileSyncJobs } from "@opencompany/db/schema";

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
  const now = new Date();
  const nextRunAt = new Date(now.getTime() + BRAIN_SYNC_DELAY_MS);
  return db
    .insert(agentFileSyncJobs)
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
      target: [agentFileSyncJobs.workspaceId, agentFileSyncJobs.path],
      set: {
        operation: input.operation,
        desiredHash: input.desiredHash,
        previousPath: input.previousPath ?? null,
        previousBlobSha: input.previousBlobSha ?? null,
        status: "pending",
        attempts: 0,
        nextRunAt,
        lastError: null,
        updatedAt: now,
      },
    });
}

export function agentBundleConflictPath(path: string) {
  const dot = path.lastIndexOf(".");
  const suffix = `.conflict-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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
    if (!isPathInsideAgentBundle(path, input.newBundleDir)) {
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
