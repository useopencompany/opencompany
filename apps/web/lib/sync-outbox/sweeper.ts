import { getDb } from "@opencompany/db/client";
import { agentSyncJobs, brainSyncJobs } from "@opencompany/db/schema";
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

  await step.sendEvent(
    "dispatch agent sync requests",
    dueJobs.map((job) => ({
      name: AGENT_SYNC_REQUESTED_EVENT,
      data: job,
    })),
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

  await step.sendEvent(
    "dispatch brain sync requests",
    dueJobs.map((job) => ({
      name: BRAIN_SYNC_REQUESTED_EVENT,
      data: job,
    })),
  );
  return { dispatched: dueJobs.length };
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
