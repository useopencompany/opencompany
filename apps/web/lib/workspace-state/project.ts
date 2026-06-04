import { serializeAgentFile } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import {
  agentFiles,
  agents,
  brainFiles,
  workspaceSyncJobs,
  workspaces,
} from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, asc, eq, inArray, lte, or } from "drizzle-orm";
import { hashAgentSource } from "@/lib/agents/hash";
import { normalizeAgentConfig } from "@/lib/agents/payload";
import { BRAIN_ROOT } from "@/lib/brain/paths";
import { nextSyncRetryAt, SYNC_OUTBOX_MAX_ATTEMPTS } from "@/lib/sync-outbox/retry";
import { type CommitUpsert, commitWorkspaceChanges } from "@/lib/workspace-state/git-data-api";
import { ensureWorkspaceRepository } from "@/lib/workspace-state/github";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

// A "syncing" job whose lease is older than this is assumed to belong to a
// crashed run and is reclaimed by the next projection. Without this, a process
// death between "mark syncing" and "delete job" would strand the job forever
// (the sweeper only re-dispatches pending/failed).
const SYNCING_LEASE_MS = 5 * 60_000;

const PROJECTION_MAX_FILES_IN_MESSAGE = 50;

// Bound a single commit's size. Each job contributes at most two tree entries
// (a rename = add new + delete old), so this caps a commit at ~2x entries.
// Excess jobs stay pending and are drained by the next projection round.
const PROJECTION_MAX_JOBS_PER_COMMIT = 200;

type Db = ReturnType<typeof getDb>;
type WorkspaceSyncJobRow = typeof workspaceSyncJobs.$inferSelect;

export type ProjectWorkspaceResult =
  | { status: "idle" }
  | { status: "noop"; jobs: number }
  | { status: "synced"; commitSha: string; upserts: number; deletes: number };

// Per-job plan after resolving canonical content. `upsert` contributes a tree
// entry + a mark-synced write; `deletePaths` contributes delete tree entries
// (the job's own path for deletes, plus the prior path for renames).
type PlannedJob = {
  job: WorkspaceSyncJobRow;
  upsert: (CommitUpsert & { committedHash: string }) | null;
  deletePaths: string[];
};

/**
 * Drain all due workspace_sync_jobs for one workspace and project them to GitHub
 * as a SINGLE commit. Postgres is authoritative; this is the only place that
 * writes workspace file state to GitHub. Idempotent under partial failure — see
 * the hash/status guards below.
 */
export async function projectWorkspaceToGitHub(input: {
  workspaceId: string;
}): Promise<ProjectWorkspaceResult> {
  const db = getDb();
  const now = new Date();

  const dueJobs = await loadDueJobs(db, input.workspaceId, now);
  if (dueJobs.length === 0) return { status: "idle" };

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  if (!workspace) {
    // Workspace gone (deleted). Drop the orphaned jobs.
    await db.delete(workspaceSyncJobs).where(
      inArray(
        workspaceSyncJobs.id,
        dueJobs.map((job) => job.id),
      ),
    );
    return { status: "idle" };
  }

  // Cap how many jobs go into one commit. dueJobs is ordered by nextRunAt asc,
  // so the oldest are flushed first; the remainder stays pending and the
  // syncWorkspaceToGitHub drain-loop re-invokes us (it loops while "synced").
  const jobs = dueJobs.slice(0, PROJECTION_MAX_JOBS_PER_COMMIT);
  if (dueJobs.length > jobs.length) {
    logger.info("Capped workspace projection batch", {
      event: "opencompany.workspace_projection_capped",
      workspace_id: input.workspaceId,
      due: dueJobs.length,
      committing: jobs.length,
    });
  }

  // Lease the jobs so a concurrent sweeper/event run doesn't double-process.
  const jobIds = jobs.map((job) => job.id);
  await db
    .update(workspaceSyncJobs)
    .set({ status: "syncing", lastError: null, updatedAt: now })
    .where(inArray(workspaceSyncJobs.id, jobIds));

  const planned = await planJobs(db, input.workspaceId, jobs);

  const upserts = planned.flatMap((entry) => (entry.upsert ? [entry.upsert] : []));
  const upsertPaths = new Set(upserts.map((file) => file.path));
  const deletes = dedupePaths(planned.flatMap((entry) => entry.deletePaths))
    .filter((path) => !upsertPaths.has(path))
    .map((path) => ({ path }));

  // Everything was a no-op or a dropped/orphaned job: nothing to commit. Clean
  // up the leased jobs (status-guarded) and return.
  if (upserts.length === 0 && deletes.length === 0) {
    await deleteLeasedJobs(db, jobIds);
    return { status: "noop", jobs: planned.length };
  }

  const repository = await ensureWorkspaceRepository({ db, workspace });

  try {
    const commit = await commitWorkspaceChanges({
      repo: { fullName: repository.fullName, defaultBranch: repository.defaultBranch },
      message: buildCommitMessage(upserts, deletes),
      upserts: upserts.map((file) => ({ path: file.path, content: file.content })),
      deletes,
    });

    if (!commit) {
      // The tree matched HEAD exactly (already in sync). Treat as a no-op.
      await deleteLeasedJobs(db, jobIds);
      return { status: "noop", jobs: planned.length };
    }

    await markSyncedAndClear(db, {
      planned,
      jobIds,
      commitSha: commit.commitSha,
      blobShaByPath: commit.blobShaByPath,
      now: new Date(),
    });
    return {
      status: "synced",
      commitSha: commit.commitSha,
      upserts: upserts.length,
      deletes: deletes.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub sync error";
    captureException(error, {
      event: "opencompany.workspace_github_sync_failed",
      workspace_id: input.workspaceId,
      jobs: planned.length,
    });
    logger.error("Workspace GitHub projection failed", {
      event: "opencompany.workspace_github_sync_failed",
      workspace_id: input.workspaceId,
      jobs: planned.length,
      error_message: message,
    });
    await markFailed(db, { planned, now: new Date(), message });
    throw error;
  }
}

async function loadDueJobs(db: Db, workspaceId: string, now: Date) {
  const leaseCutoff = new Date(now.getTime() - SYNCING_LEASE_MS);
  const rows = await db
    .select()
    .from(workspaceSyncJobs)
    .where(
      and(
        eq(workspaceSyncJobs.workspaceId, workspaceId),
        lte(workspaceSyncJobs.nextRunAt, now),
        or(
          inArray(workspaceSyncJobs.status, ["pending", "failed"]),
          and(
            eq(workspaceSyncJobs.status, "syncing"),
            lte(workspaceSyncJobs.updatedAt, leaseCutoff),
          ),
        ),
      ),
    )
    .orderBy(asc(workspaceSyncJobs.nextRunAt));

  // Drop exhausted failed jobs, mirroring the sweeper's filterDueSyncJobs.
  return rows.filter((row) => row.status !== "failed" || row.attempts < SYNC_OUTBOX_MAX_ATTEMPTS);
}

async function planJobs(
  db: Db,
  workspaceId: string,
  jobs: WorkspaceSyncJobRow[],
): Promise<PlannedJob[]> {
  const brainPaths = new Set<string>();
  const agentFilePaths = new Set<string>();
  const agentIds = new Set<string>();
  for (const job of jobs) {
    if (job.operation === "delete") continue;
    if (job.sourceKind === "brain") brainPaths.add(brainLogicalPath(job.repoPath));
    else if (job.sourceKind === "agent_file") agentFilePaths.add(job.repoPath);
    else if (job.sourceKind === "agent" && job.sourceRef) agentIds.add(job.sourceRef);
  }

  const [brainRows, agentFileRows, agentRows] = await Promise.all([
    brainPaths.size
      ? db
          .select()
          .from(brainFiles)
          .where(
            and(eq(brainFiles.workspaceId, workspaceId), inArray(brainFiles.path, [...brainPaths])),
          )
      : Promise.resolve([]),
    agentFilePaths.size
      ? db
          .select()
          .from(agentFiles)
          .where(
            and(
              eq(agentFiles.workspaceId, workspaceId),
              inArray(agentFiles.path, [...agentFilePaths]),
            ),
          )
      : Promise.resolve([]),
    agentIds.size
      ? db
          .select()
          .from(agents)
          .where(and(eq(agents.workspaceId, workspaceId), inArray(agents.id, [...agentIds])))
      : Promise.resolve([]),
  ]);

  const brainByPath = new Map(brainRows.map((row) => [row.path, row]));
  const agentFileByPath = new Map(agentFileRows.map((row) => [row.path, row]));
  const agentById = new Map(agentRows.map((row) => [row.id, row]));

  return jobs.map((job) => planJob(job, { brainByPath, agentFileByPath, agentById }));
}

function planJob(
  job: WorkspaceSyncJobRow,
  lookups: {
    brainByPath: Map<string, typeof brainFiles.$inferSelect>;
    agentFileByPath: Map<string, typeof agentFiles.$inferSelect>;
    agentById: Map<string, typeof agents.$inferSelect>;
  },
): PlannedJob {
  const renamePath =
    job.previousPath && job.previousPath !== job.repoPath ? job.previousPath : null;

  if (job.operation === "delete") {
    return { job, upsert: null, deletePaths: [job.repoPath] };
  }

  const resolved = resolveDesiredContent(job, lookups);
  if (!resolved) {
    // Canonical row vanished between enqueue and projection — drop the job.
    return { job, upsert: null, deletePaths: [] };
  }

  // No-op: already committed at this hash and not a rename. Skip the tree entry
  // but still clear the job. (A rename must always re-emit the move.)
  if (!renamePath && resolved.syncedHash === resolved.committedHash) {
    return { job, upsert: null, deletePaths: [] };
  }

  return {
    job,
    upsert: {
      path: job.repoPath,
      content: resolved.content,
      committedHash: resolved.committedHash,
    },
    deletePaths: renamePath ? [renamePath] : [],
  };
}

function resolveDesiredContent(
  job: WorkspaceSyncJobRow,
  lookups: {
    brainByPath: Map<string, typeof brainFiles.$inferSelect>;
    agentFileByPath: Map<string, typeof agentFiles.$inferSelect>;
    agentById: Map<string, typeof agents.$inferSelect>;
  },
): { content: string; committedHash: string; syncedHash: string | null } | null {
  if (job.sourceKind === "brain") {
    const row = lookups.brainByPath.get(brainLogicalPath(job.repoPath));
    if (!row) return null;
    return {
      content: row.content,
      committedHash: row.contentHash,
      syncedHash: row.githubSyncedHash,
    };
  }
  if (job.sourceKind === "agent_file") {
    const row = lookups.agentFileByPath.get(job.repoPath);
    if (!row) return null;
    return {
      content: row.content,
      committedHash: row.contentHash,
      syncedHash: row.githubSyncedHash,
    };
  }
  if (job.sourceKind === "agent") {
    if (!job.sourceRef) return null;
    const row = lookups.agentById.get(job.sourceRef);
    if (!row || !row.path) return null;
    const source = serializeAgentSource(row);
    return {
      content: source,
      committedHash: hashAgentSource(source),
      syncedHash: row.githubSyncedHash,
    };
  }
  return null;
}

// Re-serialize an agent row into its .agent file the same way the agent editor
// and self-edit paths do, so the committed hash matches the agents.contentHash
// gate (serializeAgentFile + hashAgentSource).
function serializeAgentSource(agent: typeof agents.$inferSelect): string {
  const config = normalizeAgentConfig(agent.config);
  return serializeAgentFile({
    title: agent.name,
    body: agent.body,
    model: config.model.name,
    tools: config.tools,
    brain: config.brain,
    agents: config.agents ?? [],
    skills: config.skills ?? [],
    integrations: config.integrations,
    triggers: config.triggers,
  });
}

async function markSyncedAndClear(
  db: Db,
  input: {
    planned: PlannedJob[];
    jobIds: number[];
    commitSha: string;
    blobShaByPath: Map<string, string>;
    now: Date;
  },
) {
  const writes = [];
  for (const entry of input.planned) {
    if (!entry.upsert) continue;
    const blobSha = input.blobShaByPath.get(entry.upsert.path) ?? null;
    const synced = {
      githubBlobSha: blobSha,
      githubCommitSha: input.commitSha,
      githubSyncedHash: entry.upsert.committedHash,
      githubSyncedAt: input.now,
      githubSyncStatus: "synced" as const,
      githubSyncError: null,
      updatedAt: input.now,
    };
    writes.push(
      markSourceSynced(db, entry.job, entry.upsert.committedHash, synced, input.commitSha),
    );
  }
  // Hash/status-guarded job cleanup: only delete jobs still in the "syncing"
  // state we leased. A producer re-enqueue flips status back to "pending",
  // so a concurrently-edited path's job survives and re-dispatches.
  writes.push(
    db
      .delete(workspaceSyncJobs)
      .where(
        and(inArray(workspaceSyncJobs.id, input.jobIds), eq(workspaceSyncJobs.status, "syncing")),
      ),
  );
  await db.batch(writes as [(typeof writes)[number], ...(typeof writes)[number][]]);
}

function markSourceSynced(
  db: Db,
  job: WorkspaceSyncJobRow,
  committedHash: string,
  synced: {
    githubBlobSha: string | null;
    githubCommitSha: string;
    githubSyncedHash: string;
    githubSyncedAt: Date;
    githubSyncStatus: "synced";
    githubSyncError: null;
    updatedAt: Date;
  },
  commitSha: string,
) {
  if (job.sourceKind === "brain") {
    return db
      .update(brainFiles)
      .set(synced)
      .where(
        and(
          eq(brainFiles.workspaceId, job.workspaceId),
          eq(brainFiles.path, brainLogicalPath(job.repoPath)),
          eq(brainFiles.contentHash, committedHash),
        ),
      );
  }
  if (job.sourceKind === "agent_file") {
    return db
      .update(agentFiles)
      .set(synced)
      .where(
        and(
          eq(agentFiles.workspaceId, job.workspaceId),
          eq(agentFiles.path, job.repoPath),
          eq(agentFiles.contentHash, committedHash),
        ),
      );
  }
  // agent
  return db
    .update(agents)
    .set({ ...synced, commitSha })
    .where(
      and(
        eq(agents.workspaceId, job.workspaceId),
        eq(agents.id, job.sourceRef ?? ""),
        eq(agents.contentHash, committedHash),
      ),
    );
}

async function markFailed(db: Db, input: { planned: PlannedJob[]; now: Date; message: string }) {
  const writes = [];
  for (const entry of input.planned) {
    const failedAttempts = entry.job.attempts + 1;
    writes.push(
      db
        .update(workspaceSyncJobs)
        .set({
          status: "failed",
          attempts: failedAttempts,
          nextRunAt: nextSyncRetryAt(input.now, failedAttempts),
          lastError: input.message,
          updatedAt: input.now,
        })
        .where(eq(workspaceSyncJobs.id, entry.job.id)),
    );
    if (entry.upsert) {
      writes.push(
        markSourceFailed(db, entry.job, entry.upsert.committedHash, input.message, input.now),
      );
    }
  }
  if (writes.length === 0) return;
  await db.batch(writes as [(typeof writes)[number], ...(typeof writes)[number][]]);
}

function markSourceFailed(
  db: Db,
  job: WorkspaceSyncJobRow,
  committedHash: string,
  message: string,
  now: Date,
) {
  const failed = { githubSyncStatus: "failed", githubSyncError: message, updatedAt: now };
  if (job.sourceKind === "brain") {
    return db
      .update(brainFiles)
      .set(failed)
      .where(
        and(
          eq(brainFiles.workspaceId, job.workspaceId),
          eq(brainFiles.path, brainLogicalPath(job.repoPath)),
          eq(brainFiles.contentHash, committedHash),
        ),
      );
  }
  if (job.sourceKind === "agent_file") {
    return db
      .update(agentFiles)
      .set(failed)
      .where(
        and(
          eq(agentFiles.workspaceId, job.workspaceId),
          eq(agentFiles.path, job.repoPath),
          eq(agentFiles.contentHash, committedHash),
        ),
      );
  }
  return db
    .update(agents)
    .set(failed)
    .where(
      and(
        eq(agents.workspaceId, job.workspaceId),
        eq(agents.id, job.sourceRef ?? ""),
        eq(agents.contentHash, committedHash),
      ),
    );
}

async function deleteLeasedJobs(db: Db, jobIds: number[]) {
  await db
    .delete(workspaceSyncJobs)
    .where(and(inArray(workspaceSyncJobs.id, jobIds), eq(workspaceSyncJobs.status, "syncing")));
}

function brainLogicalPath(repoPath: string) {
  const prefix = `${BRAIN_ROOT}/`;
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath;
}

function dedupePaths(paths: string[]) {
  return [...new Set(paths)];
}

function buildCommitMessage(upserts: Array<{ path: string }>, deletes: Array<{ path: string }>) {
  const changed = [
    ...upserts.map((file) => `Update ${file.path}`),
    ...deletes.map((file) => `Delete ${file.path}`),
  ];
  if (changed.length === 1) return changed[0]!;

  const verb = upserts.length === 0 ? "Delete" : "Update";
  const summary = `${verb} ${changed.length} workspace files`;
  const body = changed.slice(0, PROJECTION_MAX_FILES_IN_MESSAGE).join("\n");
  const truncated =
    changed.length > PROJECTION_MAX_FILES_IN_MESSAGE
      ? `\n…and ${changed.length - PROJECTION_MAX_FILES_IN_MESSAGE} more`
      : "";
  return `${summary}\n\n${body}${truncated}`;
}
