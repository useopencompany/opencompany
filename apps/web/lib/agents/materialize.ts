import { getDb } from "@opencompany/db/client";
import { agentSyncJobs, agents, workspaces } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { serializeAgentFile } from "@/lib/agents/agent-file";
import { hashAgentSource } from "@/lib/agents/hash";
import {
  ensureWorkspaceRepository,
  writeWorkspaceFile,
} from "@/lib/workspace-state/github";
import {
  endTimingTrace,
  startTimingTrace,
  timeAsync,
} from "@/lib/observability/timing";

type MaterializeMode = "scheduled" | "force";

export type MaterializeResult =
  | { status: "missing" }
  | { status: "deferred"; nextRunAt: Date }
  | { status: "synced"; commitSha: string | null; blobSha: string | null }
  | { status: "unchanged" }
  | { status: "stale" };

export async function materializeAgentToGitHub(
  agentId: string,
  options: { mode: MaterializeMode } = { mode: "scheduled" },
): Promise<MaterializeResult> {
  const trace = startTimingTrace("agents.materializeToGitHub", {
    mode: options.mode,
  });
  const db = getDb();

  const [row] = await timeAsync(trace, "db.selectAgentForMaterialize", () =>
    db
      .select({
        agent: agents,
        workspace: workspaces,
        job: agentSyncJobs,
      })
      .from(agents)
      .innerJoin(workspaces, eq(agents.workspaceId, workspaces.id))
      .leftJoin(agentSyncJobs, eq(agentSyncJobs.agentId, agents.id))
      .where(eq(agents.id, agentId))
      .limit(1),
  );

  if (!row) {
    endTimingTrace(trace, { status: "missing" });
    return { status: "missing" };
  }

  if (!row.agent.path) {
    endTimingTrace(trace, { status: "missing-path" });
    return { status: "missing" };
  }

  if (
    options.mode === "scheduled" &&
    row.job?.nextRunAt &&
    row.job.nextRunAt.getTime() > Date.now()
  ) {
    endTimingTrace(trace, { status: "deferred", path: row.agent.path });
    return { status: "deferred", nextRunAt: row.job.nextRunAt };
  }

  const source = serializeAgentFile({
    title: row.agent.name,
    body: row.agent.body,
  });
  const contentHash = hashAgentSource(source);

  if (row.agent.githubSyncedHash === contentHash) {
    await timeAsync(trace, "db.deleteUnchangedSyncJob", () =>
      db
        .delete(agentSyncJobs)
        .where(
          and(
            eq(agentSyncJobs.agentId, row.agent.id),
            eq(agentSyncJobs.desiredHash, contentHash),
          ),
        ),
    );
    endTimingTrace(trace, { status: "unchanged", path: row.agent.path });
    return { status: "unchanged" };
  }

  await timeAsync(trace, "db.markSyncing", () =>
    db
      .update(agents)
      .set({
        githubSyncStatus: "syncing",
        githubSyncError: null,
      })
      .where(and(eq(agents.id, row.agent.id), eq(agents.contentHash, contentHash))),
  );

  try {
    const repository = await timeAsync(trace, "github.ensureRepository", () =>
      ensureWorkspaceRepository({ db, workspace: row.workspace }),
    );
    const result = await timeAsync(
      trace,
      "github.writeWorkspaceFile",
      () =>
        writeWorkspaceFile({
          db,
          repository,
          path: row.agent.path!,
          content: source,
          message: `Update ${row.agent.path}`,
          blobSha: row.agent.githubBlobSha,
        }),
      { path: row.agent.path },
    );

    const now = new Date();
    await timeAsync(trace, "db.markSynced", () =>
      db
        .update(agents)
        .set({
          commitSha: result.commitSha,
          githubBlobSha: result.blobSha,
          githubCommitSha: result.commitSha,
          githubSyncedHash: contentHash,
          githubSyncedAt: now,
          githubSyncStatus: "synced",
          githubSyncError: null,
        })
        .where(and(eq(agents.id, row.agent.id), eq(agents.contentHash, contentHash))),
    );
    await timeAsync(trace, "db.deleteSyncJob", () =>
      db
        .delete(agentSyncJobs)
        .where(
          and(
            eq(agentSyncJobs.agentId, row.agent.id),
            eq(agentSyncJobs.desiredHash, contentHash),
          ),
        ),
    );

    const [latest] = await timeAsync(trace, "db.selectLatestAgentHash", () =>
      db
        .select({ contentHash: agents.contentHash })
        .from(agents)
        .where(eq(agents.id, row.agent.id))
        .limit(1),
    );
    const status = latest?.contentHash === contentHash ? "synced" : "stale";
    endTimingTrace(trace, { status, path: row.agent.path });
    return status === "synced"
      ? {
          status,
          commitSha: result.commitSha,
          blobSha: result.blobSha,
        }
      : { status };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub sync error";
    await timeAsync(trace, "db.markSyncFailed", () =>
      db
        .update(agents)
        .set({
          githubSyncStatus: "failed",
          githubSyncError: message,
        })
        .where(and(eq(agents.id, row.agent.id), eq(agents.contentHash, contentHash))),
    );
    await timeAsync(trace, "db.recordSyncJobFailure", () =>
      db
        .update(agentSyncJobs)
        .set({
          status: "failed",
          attempts: (row.job?.attempts ?? 0) + 1,
          lastError: message,
          updatedAt: new Date(),
        })
        .where(eq(agentSyncJobs.agentId, row.agent.id)),
    );
    endTimingTrace(trace, {
      status: "failed",
      path: row.agent.path,
      error: message,
    });
    throw error;
  }
}
