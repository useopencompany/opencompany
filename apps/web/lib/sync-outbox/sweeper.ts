import { getDb } from "@opencompany/db/client";
import { workspaceSyncJobs } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, asc, eq, inArray, lte, or } from "drizzle-orm";
import { SYNC_OUTBOX_MAX_ATTEMPTS } from "@/lib/sync-outbox/retry";
import { WORKSPACE_SYNC_REQUESTED_EVENT } from "@/lib/workspace-state/sync-events";

export {
  nextSyncRetryAt,
  SYNC_OUTBOX_MAX_ATTEMPTS,
  SYNC_OUTBOX_RETRY_BASE_MS,
  SYNC_OUTBOX_RETRY_MAX_MS,
} from "@/lib/sync-outbox/retry";

type Db = ReturnType<typeof getDb>;

// A "syncing" job whose lease is older than this is reclaimable (the owning run
// likely crashed). Mirrors SYNCING_LEASE_MS in workspace-state/project.ts so the
// sweeper wakes a workspace whose projection died mid-flight.
const WORKSPACE_SYNCING_LEASE_MS = 5 * 60_000;

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export const SYNC_OUTBOX_SWEEP_CRON = "* * * * *";
export const SYNC_OUTBOX_SWEEP_LIMIT = 50;

const RETRYABLE_SYNC_JOB_STATUSES = ["pending", "failed"] as const;

export type WorkspaceSyncDispatch = {
  workspaceId: string;
};

type SyncOutboxEvent = { name: typeof WORKSPACE_SYNC_REQUESTED_EVENT; data: WorkspaceSyncDispatch };

type SyncOutboxStep = {
  run(id: string, handler: () => unknown): Promise<unknown>;
  sendEvent(id: string, payload: SyncOutboxEvent[]): Promise<unknown>;
};

// Workspace projection outbox: one event per workspace (not per path), because
// projectWorkspaceToGitHub drains all due jobs for a workspace into one commit.
// This is the runner's only path to GitHub (it does not dispatch) and the
// backstop for any missed web dispatch.
export async function loadDueWorkspaceSyncDispatches(
  options: { db?: Db; now?: Date; limit?: number } = {},
): Promise<WorkspaceSyncDispatch[]> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const limit = options.limit ?? SYNC_OUTBOX_SWEEP_LIMIT;
  const leaseCutoff = new Date(now.getTime() - WORKSPACE_SYNCING_LEASE_MS);

  const rows = await db
    .select({
      workspaceId: workspaceSyncJobs.workspaceId,
      status: workspaceSyncJobs.status,
      attempts: workspaceSyncJobs.attempts,
      nextRunAt: workspaceSyncJobs.nextRunAt,
    })
    .from(workspaceSyncJobs)
    .where(
      and(
        lte(workspaceSyncJobs.nextRunAt, now),
        or(
          inArray(workspaceSyncJobs.status, RETRYABLE_SYNC_JOB_STATUSES),
          and(
            eq(workspaceSyncJobs.status, "syncing"),
            lte(workspaceSyncJobs.updatedAt, leaseCutoff),
          ),
        ),
      ),
    )
    .orderBy(asc(workspaceSyncJobs.nextRunAt));

  const seen = new Set<string>();
  const dispatches: WorkspaceSyncDispatch[] = [];
  for (const row of rows) {
    if (row.status === "failed" && row.attempts >= SYNC_OUTBOX_MAX_ATTEMPTS) continue;
    if (seen.has(row.workspaceId)) continue;
    seen.add(row.workspaceId);
    dispatches.push({ workspaceId: row.workspaceId });
    if (dispatches.length >= limit) break;
  }
  return dispatches;
}

export async function sweepWorkspaceSyncOutbox(
  step: SyncOutboxStep,
  options: { loadDueDispatches?: () => Promise<WorkspaceSyncDispatch[]> } = {},
) {
  const dueJobs = (await step.run("load due workspace sync jobs", () =>
    (options.loadDueDispatches ?? loadDueWorkspaceSyncDispatches)(),
  )) as WorkspaceSyncDispatch[];
  if (dueJobs.length === 0) return { dispatched: 0 };

  const events: SyncOutboxEvent[] = dueJobs.map((job) => ({
    name: WORKSPACE_SYNC_REQUESTED_EVENT,
    data: job,
  }));
  await dispatchRecoveryEvents(step, "dispatch workspace sync requests", events, dueJobs.length);
  return { dispatched: dueJobs.length };
}

async function dispatchRecoveryEvents(
  step: SyncOutboxStep,
  id: string,
  events: SyncOutboxEvent[],
  dispatchedCount: number,
) {
  try {
    await step.sendEvent(id, events);
  } catch (error) {
    captureException(error, {
      event: "opencompany.sync_outbox_recovery_dispatch_failed",
      resource_type: "workspace",
      dispatched_count: dispatchedCount,
    });
    logger.error("Failed to dispatch sync outbox recovery events", {
      event: "opencompany.sync_outbox_recovery_dispatch_failed",
      resource_type: "workspace",
      dispatched_count: dispatchedCount,
      ...errorLogFields(error),
    });
    throw error;
  }

  logger.warn("Dispatched sync outbox recovery events", {
    event: "opencompany.sync_outbox_recovery_dispatched",
    resource_type: "workspace",
    dispatched_count: dispatchedCount,
  });
}

function errorLogFields(error: unknown) {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
    };
  }

  return {
    error_name: typeof error,
    error_message: typeof error === "string" ? error : "Unknown error",
  };
}
