import { getDb } from "@opencompany/db/client";
import { workspaceSyncJobs } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, asc, inArray, lte } from "drizzle-orm";
import { SYNC_OUTBOX_MAX_ATTEMPTS } from "@/lib/sync-outbox/retry";
import { WORKSPACE_SYNC_REQUESTED_EVENT } from "@/lib/workspace-sync/events";

type Db = ReturnType<typeof getDb>;

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export {
  nextSyncRetryAt,
  SYNC_OUTBOX_MAX_ATTEMPTS,
  SYNC_OUTBOX_RETRY_BASE_MS,
  SYNC_OUTBOX_RETRY_MAX_MS,
} from "@/lib/sync-outbox/retry";

export const SYNC_OUTBOX_SWEEP_CRON = "* * * * *";
export const SYNC_OUTBOX_SWEEP_LIMIT = 50;

const RETRYABLE_SYNC_JOB_STATUSES = ["pending", "failed"] as const;

type WorkspaceSyncJobCandidate = {
  workspaceId: string;
  status: string;
  attempts: number;
  nextRunAt: Date;
};

export type WorkspaceSyncDispatch = {
  workspaceId: string;
};

type SyncOutboxEvent = {
  name: typeof WORKSPACE_SYNC_REQUESTED_EVENT;
  data: WorkspaceSyncDispatch;
};

type SyncOutboxStep = {
  run(id: string, handler: () => unknown): Promise<unknown>;
  sendEvent(id: string, payload: SyncOutboxEvent[]): Promise<unknown>;
};

export function filterDueWorkspaceSyncJobs(
  rows: WorkspaceSyncJobCandidate[],
  options: { now?: Date; limit?: number } = {},
): WorkspaceSyncDispatch[] {
  const now = options.now ?? new Date();
  const limit = options.limit ?? SYNC_OUTBOX_SWEEP_LIMIT;
  return rows
    .filter(
      (row) =>
        RETRYABLE_SYNC_JOB_STATUSES.includes(
          row.status as (typeof RETRYABLE_SYNC_JOB_STATUSES)[number],
        ) &&
        row.nextRunAt.getTime() <= now.getTime() &&
        (row.status !== "failed" || row.attempts < SYNC_OUTBOX_MAX_ATTEMPTS),
    )
    .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
    .slice(0, limit)
    .map((row) => ({ workspaceId: row.workspaceId }));
}

export async function loadDueWorkspaceSyncDispatches(
  options: { db?: Db; now?: Date; limit?: number } = {},
): Promise<WorkspaceSyncDispatch[]> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const limit = options.limit ?? SYNC_OUTBOX_SWEEP_LIMIT;
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
        inArray(workspaceSyncJobs.status, RETRYABLE_SYNC_JOB_STATUSES),
        lte(workspaceSyncJobs.nextRunAt, now),
      ),
    )
    .orderBy(asc(workspaceSyncJobs.nextRunAt))
    .limit(limit);

  return filterDueWorkspaceSyncJobs(rows, { now, limit });
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
