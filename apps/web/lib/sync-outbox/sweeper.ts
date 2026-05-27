import { getDb } from "@opencompany/db/client";
import { agentSyncJobs, brainSyncJobs } from "@opencompany/db/schema";
import { captureException, createLogger } from "@opencompany/observability";
import { and, asc, inArray, lte } from "drizzle-orm";
import { AGENT_SYNC_REQUESTED_EVENT } from "@/lib/agents/sync-events";
import { BRAIN_SYNC_REQUESTED_EVENT } from "@/lib/brain/sync-events";
import { SYNC_OUTBOX_MAX_ATTEMPTS } from "@/lib/sync-outbox/retry";

export {
  nextSyncRetryAt,
  SYNC_OUTBOX_MAX_ATTEMPTS,
  SYNC_OUTBOX_RETRY_BASE_MS,
  SYNC_OUTBOX_RETRY_MAX_MS,
} from "@/lib/sync-outbox/retry";

type Db = ReturnType<typeof getDb>;
type SyncResourceType = "agent" | "brain";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

export const SYNC_OUTBOX_SWEEP_CRON = "* * * * *";
export const SYNC_OUTBOX_SWEEP_LIMIT = 50;

const RETRYABLE_SYNC_JOB_STATUSES = ["pending", "failed"] as const;

type SyncJobCandidate = {
  status: string;
  attempts: number;
  nextRunAt: Date;
};

type AgentSyncJobCandidate = SyncJobCandidate & {
  agentId: string;
  workspaceId: string;
};

type BrainSyncJobCandidate = SyncJobCandidate & {
  workspaceId: string;
  path: string;
};

export type AgentSyncDispatch = {
  agentId: string;
  workspaceId: string;
};

export type BrainSyncDispatch = {
  workspaceId: string;
  path: string;
};

type SyncOutboxEvent =
  | { name: typeof AGENT_SYNC_REQUESTED_EVENT; data: AgentSyncDispatch }
  | { name: typeof BRAIN_SYNC_REQUESTED_EVENT; data: BrainSyncDispatch };

type SyncOutboxStep = {
  run(id: string, handler: () => unknown): Promise<unknown>;
  sendEvent(id: string, payload: SyncOutboxEvent[]): Promise<unknown>;
};

export function filterDueAgentSyncJobs(
  rows: AgentSyncJobCandidate[],
  options: { now?: Date; limit?: number } = {},
): AgentSyncDispatch[] {
  const now = options.now ?? new Date();
  return filterDueSyncJobs(rows, now, options.limit ?? SYNC_OUTBOX_SWEEP_LIMIT).map((row) => ({
    agentId: row.agentId,
    workspaceId: row.workspaceId,
  }));
}

export function filterDueBrainSyncJobs(
  rows: BrainSyncJobCandidate[],
  options: { now?: Date; limit?: number } = {},
): BrainSyncDispatch[] {
  const now = options.now ?? new Date();
  return filterDueSyncJobs(rows, now, options.limit ?? SYNC_OUTBOX_SWEEP_LIMIT).map((row) => ({
    workspaceId: row.workspaceId,
    path: row.path,
  }));
}

export async function loadDueAgentSyncDispatches(
  options: { db?: Db; now?: Date; limit?: number } = {},
): Promise<AgentSyncDispatch[]> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const limit = options.limit ?? SYNC_OUTBOX_SWEEP_LIMIT;
  const rows = await db
    .select({
      agentId: agentSyncJobs.agentId,
      workspaceId: agentSyncJobs.workspaceId,
      status: agentSyncJobs.status,
      attempts: agentSyncJobs.attempts,
      nextRunAt: agentSyncJobs.nextRunAt,
    })
    .from(agentSyncJobs)
    .where(
      and(
        inArray(agentSyncJobs.status, RETRYABLE_SYNC_JOB_STATUSES),
        lte(agentSyncJobs.nextRunAt, now),
      ),
    )
    .orderBy(asc(agentSyncJobs.nextRunAt))
    .limit(limit);

  return filterDueAgentSyncJobs(rows, { now, limit });
}

export async function loadDueBrainSyncDispatches(
  options: { db?: Db; now?: Date; limit?: number } = {},
): Promise<BrainSyncDispatch[]> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const limit = options.limit ?? SYNC_OUTBOX_SWEEP_LIMIT;
  const rows = await db
    .select({
      workspaceId: brainSyncJobs.workspaceId,
      path: brainSyncJobs.path,
      status: brainSyncJobs.status,
      attempts: brainSyncJobs.attempts,
      nextRunAt: brainSyncJobs.nextRunAt,
    })
    .from(brainSyncJobs)
    .where(
      and(
        inArray(brainSyncJobs.status, RETRYABLE_SYNC_JOB_STATUSES),
        lte(brainSyncJobs.nextRunAt, now),
      ),
    )
    .orderBy(asc(brainSyncJobs.nextRunAt))
    .limit(limit);

  return filterDueBrainSyncJobs(rows, { now, limit });
}

export async function sweepAgentSyncOutbox(
  step: SyncOutboxStep,
  options: { loadDueDispatches?: () => Promise<AgentSyncDispatch[]> } = {},
) {
  const dueJobs = (await step.run("load due agent sync jobs", () =>
    (options.loadDueDispatches ?? loadDueAgentSyncDispatches)(),
  )) as AgentSyncDispatch[];
  if (dueJobs.length === 0) return { dispatched: 0 };

  const events: SyncOutboxEvent[] = dueJobs.map((job) => ({
    name: AGENT_SYNC_REQUESTED_EVENT,
    data: job,
  }));
  await dispatchRecoveryEvents(
    step,
    "dispatch agent sync requests",
    events,
    "agent",
    dueJobs.length,
  );
  return { dispatched: dueJobs.length };
}

export async function sweepBrainSyncOutbox(
  step: SyncOutboxStep,
  options: { loadDueDispatches?: () => Promise<BrainSyncDispatch[]> } = {},
) {
  const dueJobs = (await step.run("load due brain sync jobs", () =>
    (options.loadDueDispatches ?? loadDueBrainSyncDispatches)(),
  )) as BrainSyncDispatch[];
  if (dueJobs.length === 0) return { dispatched: 0 };

  const events: SyncOutboxEvent[] = dueJobs.map((job) => ({
    name: BRAIN_SYNC_REQUESTED_EVENT,
    data: job,
  }));
  await dispatchRecoveryEvents(
    step,
    "dispatch brain sync requests",
    events,
    "brain",
    dueJobs.length,
  );
  return { dispatched: dueJobs.length };
}

async function dispatchRecoveryEvents(
  step: SyncOutboxStep,
  id: string,
  events: SyncOutboxEvent[],
  resourceType: SyncResourceType,
  dispatchedCount: number,
) {
  try {
    await step.sendEvent(id, events);
  } catch (error) {
    captureException(error, {
      event: "opencompany.sync_outbox_recovery_dispatch_failed",
      resource_type: resourceType,
      dispatched_count: dispatchedCount,
    });
    logger.error("Failed to dispatch sync outbox recovery events", {
      event: "opencompany.sync_outbox_recovery_dispatch_failed",
      resource_type: resourceType,
      dispatched_count: dispatchedCount,
      ...errorLogFields(error),
    });
    throw error;
  }

  logger.warn("Dispatched sync outbox recovery events", {
    event: "opencompany.sync_outbox_recovery_dispatched",
    resource_type: resourceType,
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

function filterDueSyncJobs<T extends SyncJobCandidate>(rows: T[], now: Date, limit: number): T[] {
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
    .slice(0, limit);
}
