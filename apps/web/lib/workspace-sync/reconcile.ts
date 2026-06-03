import { serializeAgentFile } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  agentFiles,
  agents,
  brainFiles,
  workspaceRepositories,
  workspaceSyncJobs,
  workspaces,
} from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, eq, sql } from "drizzle-orm";
import { hashAgentSource } from "@/lib/agents/hash";
import { normalizeAgentConfig } from "@/lib/agents/payload";
import { workspaceBrainPath } from "@/lib/brain/paths";
import { endTimingTrace, startTimingTrace, timeAsync } from "@/lib/observability/timing";
import { nextSyncRetryAt } from "@/lib/sync-outbox/retry";
import { gitBlobSha } from "@/lib/workspace-state/git-blob";
import {
  createCommit,
  createTree,
  ensureWorkspaceRepository,
  type GitTreeWriteEntry,
  getBranchHead,
  isGitHubRefUpdateConflict,
  listTreeBlobs,
  updateBranchRef,
} from "@/lib/workspace-state/github";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

// Only paths under these prefixes are authoritative-from-DB. Anything else in
// the repo (README.md, .gitignore created by auto_init) is left untouched.
const MANAGED_PREFIXES = ["brain/", "agents/"] as const;
const MAX_REF_UPDATE_ATTEMPTS = 3;

export type ReconcileResult =
  | { status: "missing" }
  | { status: "deferred"; nextRunAt: Date }
  | { status: "noop" }
  | { status: "synced"; commitSha: string; changed: number; removed: number };

type Table = "brain" | "agent" | "agent_file";

type DesiredFile = {
  table: Table;
  rowId: number | string;
  repoPath: string;
  content: string;
  // Stored sha256 content hash (matches the *contentHash column*); used as the
  // status-write-back guard so a mid-reconcile edit isn't marked synced.
  contentHash: string;
  // Git blob SHA-1 of the content; used to diff against the current GitHub tree.
  blobSha: string;
};

function isManagedPath(path: string) {
  return MANAGED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export async function reconcileWorkspaceToGitHub(input: {
  workspaceId: string;
}): Promise<ReconcileResult> {
  const trace = startTimingTrace("workspace.reconcileToGitHub", {
    workspaceId: input.workspaceId,
  });
  const db = getDb();

  const [job] = await timeAsync(trace, "db.selectSyncJob", () =>
    db
      .select()
      .from(workspaceSyncJobs)
      .where(eq(workspaceSyncJobs.workspaceId, input.workspaceId))
      .limit(1),
  );

  if (!job) {
    endTimingTrace(trace, { status: "missing" });
    return { status: "missing" };
  }

  if (job.nextRunAt.getTime() > Date.now()) {
    endTimingTrace(trace, { status: "deferred" });
    return { status: "deferred", nextRunAt: job.nextRunAt };
  }

  const [workspace] = await timeAsync(trace, "db.selectWorkspace", () =>
    db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1),
  );
  if (!workspace) {
    // Workspace gone; drop the orphaned job.
    await db.delete(workspaceSyncJobs).where(eq(workspaceSyncJobs.workspaceId, input.workspaceId));
    endTimingTrace(trace, { status: "missing" });
    return { status: "missing" };
  }

  // Mark the job and the dirty files as syncing for the UI.
  await timeAsync(trace, "db.markSyncing", () =>
    db
      .update(workspaceSyncJobs)
      .set({ status: "syncing", lastError: null, updatedAt: new Date() })
      .where(eq(workspaceSyncJobs.workspaceId, input.workspaceId)),
  );
  await timeAsync(trace, "db.markFilesSyncing", () => markFilesSyncing(db, input.workspaceId));

  logger.info("Started workspace GitHub sync", {
    event: "opencompany.workspace_github_sync_started",
    workspace_id: input.workspaceId,
  });

  try {
    const repository = await timeAsync(trace, "github.ensureRepository", () =>
      ensureWorkspaceRepository({ db, workspace }),
    );

    const desired = await timeAsync(trace, "db.loadDesired", () =>
      loadDesiredFiles(db, input.workspaceId),
    );
    const desiredByPath = new Map<string, DesiredFile>();
    for (const file of desired) desiredByPath.set(file.repoPath, file);

    // Build the commit, retrying on a non-fast-forward ref update.
    let commitSha: string | null = null;
    let changedFiles: DesiredFile[] = [];
    let syncedFiles: DesiredFile[] = [];
    let removed = 0;
    let noop = false;

    for (let attempt = 1; attempt <= MAX_REF_UPDATE_ATTEMPTS; attempt++) {
      const head = await timeAsync(trace, "github.readHead", () => getBranchHead({ repository }));
      const { entries: currentTree, truncated } = await timeAsync(trace, "github.listTree", () =>
        listTreeBlobs({ repository, treeSha: head.treeSha }),
      );
      if (truncated) {
        throw new Error(
          `GitHub tree listing for ${repository.fullName} was truncated; refusing to reconcile against an incomplete view.`,
        );
      }

      const treeEntries: GitTreeWriteEntry[] = [];
      const changed: DesiredFile[] = [];
      for (const file of desired) {
        if (currentTree.get(file.repoPath) !== file.blobSha) {
          treeEntries.push({
            path: file.repoPath,
            mode: "100644",
            type: "blob",
            content: file.content,
          });
          changed.push(file);
        }
      }
      let removals = 0;
      for (const path of currentTree.keys()) {
        if (isManagedPath(path) && !desiredByPath.has(path)) {
          treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
          removals++;
        }
      }

      if (treeEntries.length === 0) {
        commitSha = head.commitSha;
        syncedFiles = desired;
        noop = true;
        break;
      }

      const newTreeSha = await timeAsync(trace, "github.createTree", () =>
        createTree({ repository, baseTreeSha: head.treeSha, entries: treeEntries }),
      );
      const newCommitSha = await timeAsync(trace, "github.createCommit", () =>
        createCommit({
          repository,
          message: commitMessage(changed.length, removals),
          treeSha: newTreeSha,
          parentSha: head.commitSha,
        }),
      );

      try {
        await timeAsync(trace, "github.updateRef", () =>
          updateBranchRef({ repository, commitSha: newCommitSha }),
        );
      } catch (error) {
        if (isGitHubRefUpdateConflict(error) && attempt < MAX_REF_UPDATE_ATTEMPTS) {
          logger.warn("Workspace sync ref update conflicted; retrying", {
            event: "opencompany.workspace_github_sync_ref_conflict",
            workspace_id: input.workspaceId,
            attempt,
          });
          continue;
        }
        throw error;
      }

      commitSha = newCommitSha;
      changedFiles = changed;
      syncedFiles = desired;
      removed = removals;
      break;
    }

    if (!commitSha) {
      throw new Error("Workspace sync exhausted ref-update retries without committing.");
    }

    // Persist GitHub head + per-file synced status for every desired file the
    // final GitHub tree now contains, guarded on contentHash so a mid-reconcile
    // edit isn't marked synced.
    await timeAsync(trace, "db.markSynced", () =>
      persistSynced(db, {
        workspaceId: input.workspaceId,
        commitSha: commitSha as string,
        synced: syncedFiles,
      }),
    );

    // Clear the job only if no new edit re-dirtied it during the reconcile
    // (a fresh markWorkspaceDirty flips status back to "pending").
    await timeAsync(trace, "db.clearJob", () =>
      db
        .delete(workspaceSyncJobs)
        .where(
          and(
            eq(workspaceSyncJobs.workspaceId, input.workspaceId),
            eq(workspaceSyncJobs.status, "syncing"),
          ),
        ),
    );

    logger.info("Completed workspace GitHub sync", {
      event: "opencompany.workspace_github_sync_succeeded",
      workspace_id: input.workspaceId,
      commit_sha: commitSha,
      changed: changedFiles.length,
      removed,
      noop,
    });
    endTimingTrace(trace, {
      status: noop ? "noop" : "synced",
      changed: changedFiles.length,
      removed,
    });
    return noop
      ? { status: "noop" }
      : { status: "synced", commitSha, changed: changedFiles.length, removed };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub sync error";
    const failedAttempts = job.attempts + 1;
    const now = new Date();
    captureException(error, {
      event: "opencompany.workspace_github_sync_failed",
      workspace_id: input.workspaceId,
    });
    await db.batch([
      db
        .update(workspaceSyncJobs)
        .set({
          status: "failed",
          attempts: failedAttempts,
          nextRunAt: nextSyncRetryAt(now, failedAttempts),
          lastError: message,
          updatedAt: now,
        })
        .where(eq(workspaceSyncJobs.workspaceId, input.workspaceId)),
      markTableFailed(db, brainFiles, input.workspaceId, message, now),
      markTableFailed(db, agents, input.workspaceId, message, now),
      markTableFailed(db, agentFiles, input.workspaceId, message, now),
    ]);
    endTimingTrace(trace, { status: "failed", error: message });
    throw error;
  }
}

function commitMessage(changed: number, removed: number) {
  const parts: string[] = [];
  if (changed > 0) parts.push(`${changed} changed`);
  if (removed > 0) parts.push(`${removed} removed`);
  const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `Sync workspace state${summary}`;
}

async function loadDesiredFiles(
  db: ReturnType<typeof getDb>,
  workspaceId: string,
): Promise<DesiredFile[]> {
  const [brainRows, agentRows, agentFileRows] = await Promise.all([
    db
      .select({
        id: brainFiles.id,
        path: brainFiles.path,
        content: brainFiles.content,
        contentHash: brainFiles.contentHash,
      })
      .from(brainFiles)
      .where(eq(brainFiles.workspaceId, workspaceId)),
    db
      .select({
        id: agents.id,
        path: agents.path,
        name: agents.name,
        body: agents.body,
        config: agents.config,
        contentHash: agents.contentHash,
      })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId)),
    db
      .select({
        id: agentFiles.id,
        path: agentFiles.path,
        content: agentFiles.content,
        contentHash: agentFiles.contentHash,
      })
      .from(agentFiles)
      .where(eq(agentFiles.workspaceId, workspaceId)),
  ]);

  const desired: DesiredFile[] = [];

  for (const row of brainRows) {
    desired.push({
      table: "brain",
      rowId: row.id,
      repoPath: workspaceBrainPath(row.path),
      content: row.content,
      contentHash: row.contentHash,
      blobSha: gitBlobSha(row.content),
    });
  }

  for (const row of agentRows) {
    if (!row.path) continue;
    const config = normalizeAgentConfig(row.config);
    const source = serializeAgentFile({
      title: row.name,
      body: row.body,
      model: config.model.name,
      tools: config.tools,
      brain: config.brain,
      integrations: config.integrations,
      triggers: config.triggers,
    });
    // Fall back to the freshly computed hash if the stored column is null.
    const contentHash = row.contentHash ?? hashAgentSource(source);
    desired.push({
      table: "agent",
      rowId: row.id,
      repoPath: row.path,
      content: source,
      contentHash,
      blobSha: gitBlobSha(source),
    });
  }

  for (const row of agentFileRows) {
    desired.push({
      table: "agent_file",
      rowId: row.id,
      repoPath: row.path,
      content: row.content,
      contentHash: row.contentHash,
      blobSha: gitBlobSha(row.content),
    });
  }

  return desired;
}

function markFilesSyncing(db: ReturnType<typeof getDb>, workspaceId: string) {
  const syncing = { githubSyncStatus: "syncing", githubSyncError: null, updatedAt: new Date() };
  return db.batch([
    db
      .update(brainFiles)
      .set(syncing)
      .where(
        and(
          eq(brainFiles.workspaceId, workspaceId),
          sql`${brainFiles.githubSyncedHash} is distinct from ${brainFiles.contentHash}`,
        ),
      ),
    db
      .update(agents)
      .set(syncing)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          sql`${agents.githubSyncedHash} is distinct from ${agents.contentHash}`,
        ),
      ),
    db
      .update(agentFiles)
      .set(syncing)
      .where(
        and(
          eq(agentFiles.workspaceId, workspaceId),
          sql`${agentFiles.githubSyncedHash} is distinct from ${agentFiles.contentHash}`,
        ),
      ),
  ]);
}

async function persistSynced(
  db: ReturnType<typeof getDb>,
  input: { workspaceId: string; commitSha: string; synced: DesiredFile[] },
) {
  const now = new Date();

  await db
    .update(workspaceRepositories)
    .set({ latestHeadSha: input.commitSha, updatedAt: now })
    .where(eq(workspaceRepositories.workspaceId, input.workspaceId));

  if (input.synced.length === 0) return;

  const statements = input.synced.map((file) => {
    const synced = {
      githubSyncStatus: "synced",
      githubSyncedHash: file.contentHash,
      githubSyncedAt: now,
      githubCommitSha: input.commitSha,
      githubSyncError: null,
      updatedAt: now,
    };
    if (file.table === "brain") {
      return db
        .update(brainFiles)
        .set(synced)
        .where(
          and(
            eq(brainFiles.id, file.rowId as number),
            eq(brainFiles.contentHash, file.contentHash),
          ),
        );
    }
    if (file.table === "agent") {
      return db
        .update(agents)
        .set(synced)
        .where(and(eq(agents.id, file.rowId as string), eq(agents.contentHash, file.contentHash)));
    }
    return db
      .update(agentFiles)
      .set(synced)
      .where(
        and(eq(agentFiles.id, file.rowId as number), eq(agentFiles.contentHash, file.contentHash)),
      );
  });

  await db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]]);
}

function markTableFailed(
  db: ReturnType<typeof getDb>,
  table: typeof brainFiles | typeof agents | typeof agentFiles,
  workspaceId: string,
  message: string,
  now: Date,
) {
  return db
    .update(table)
    .set({ githubSyncStatus: "failed", githubSyncError: message, updatedAt: now })
    .where(and(eq(table.workspaceId, workspaceId), eq(table.githubSyncStatus, "syncing")));
}
