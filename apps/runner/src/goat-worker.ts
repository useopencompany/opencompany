import { randomUUID } from "node:crypto";
import type { GoatHarnessSpec, GoatTaskDebugTrace } from "@opencompany/db/goat-schema";
import { goatTasks } from "@opencompany/db/goat-schema";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import {
  executeGoatTask,
  type GoatTaskExecutorInput,
  type GoatTaskExecutorResult,
} from "./goat-harness";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-worker" });

export const GOAT_TASK_LEASE_TTL_MS = 5 * 60 * 1000;
export const GOAT_TASK_HEARTBEAT_INTERVAL_MS = 5_000;

type GoatTask = typeof goatTasks.$inferSelect;
type GoatTaskStage = GoatTask["stage"];
type GoatTaskExecutor = (input: GoatTaskExecutorInput) => Promise<GoatTaskExecutorResult>;

export type GoatTaskStore = {
  claimNext(input: {
    leaseId: string;
    leaseOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<GoatTask | null>;
  heartbeat(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<boolean>;
  updateStage(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    stage: GoatTaskStage;
    harnessSpec?: GoatHarnessSpec;
    sandboxId?: string | null;
  }): Promise<boolean>;
  complete(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    result: string;
    harnessSpec: GoatHarnessSpec;
    debugTrace: GoatTaskDebugTrace;
    sandboxId: string;
  }): Promise<boolean>;
  fail(input: {
    id: string;
    leaseId: string;
    leaseOwner: string;
    now: Date;
    error: string;
    debugTrace?: GoatTaskDebugTrace;
  }): Promise<boolean>;
};

export function createDbGoatTaskStore(): GoatTaskStore {
  return {
    async claimNext(input) {
      const result = await getDb().execute(sql`
        WITH candidate AS (
          SELECT id
          FROM goat.tasks
          WHERE
            (status = 'queued' AND next_run_at <= ${input.now})
            OR (status = 'running' AND lease_expires_at < ${input.now})
          ORDER BY next_run_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE goat.tasks AS task
        SET status = 'running',
            stage = 'planning',
            attempts = task.attempts + 1,
            lease_id = ${input.leaseId},
            lease_owner = ${input.leaseOwner},
            lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.now}
        FROM candidate
        WHERE task.id = candidate.id
        RETURNING ${goatTaskColumnsSql}
      `);
      const row = rowsFromExecute<GoatTaskRow>(result)[0];
      return row ? goatTaskFromRow(row) : null;
    },

    async heartbeat(input) {
      const result = await getDb().execute(sql`
        UPDATE goat.tasks
        SET lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.leaseOwner}
          AND status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async updateStage(input) {
      const result = await getDb().execute(sql`
        UPDATE goat.tasks
        SET stage = ${input.stage},
            harness_spec = COALESCE(${input.harnessSpec ? JSON.stringify(input.harnessSpec) : null}::jsonb, harness_spec),
            sandbox_id = COALESCE(${input.sandboxId ?? null}, sandbox_id),
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.leaseOwner}
          AND status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async complete(input) {
      const result = await getDb().execute(sql`
        UPDATE goat.tasks
        SET status = 'succeeded',
            stage = 'completed',
            result = ${input.result},
            error = NULL,
            harness_spec = ${JSON.stringify(input.harnessSpec)}::jsonb,
            debug_trace = ${JSON.stringify(input.debugTrace)}::jsonb,
            sandbox_id = ${input.sandboxId},
            lease_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.leaseOwner}
          AND status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },

    async fail(input) {
      const result = await getDb().execute(sql`
        UPDATE goat.tasks
        SET status = 'failed',
            stage = 'failed',
            error = ${input.error},
            debug_trace = COALESCE(${input.debugTrace ? JSON.stringify(input.debugTrace) : null}::jsonb, debug_trace),
            lease_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ${input.now}
        WHERE id = ${input.id}
          AND lease_id = ${input.leaseId}
          AND lease_owner = ${input.leaseOwner}
          AND status = 'running'
        RETURNING id
      `);
      return rowsFromExecute<{ id: string }>(result).length > 0;
    },
  };
}

let registeredGoatTaskWakeup: (() => void) | null = null;

export function setGoatTaskWakeup(wake: (() => void) | null) {
  registeredGoatTaskWakeup = wake;
}

export function wakeGoatTaskWorker() {
  registeredGoatTaskWakeup?.();
}

export async function claimNextGoatTask(input: {
  leaseOwner: string;
  store?: GoatTaskStore;
  leaseTtlMs?: number;
}) {
  const now = new Date();
  const leaseId = newGoatTaskLeaseId();
  return (input.store ?? createDbGoatTaskStore()).claimNext({
    leaseId,
    leaseOwner: input.leaseOwner,
    now,
    leaseExpiresAt: goatTaskLeaseExpiresAt(now, input.leaseTtlMs),
  });
}

export async function runClaimedGoatTask(input: {
  task: GoatTask;
  env: RunnerEnv;
  store?: GoatTaskStore;
  executor?: GoatTaskExecutor;
}) {
  const store = input.store ?? createDbGoatTaskStore();
  const executor = input.executor ?? executeGoatTask;
  const leaseId = requireTaskLease(input.task, "leaseId");
  const leaseOwner = requireTaskLease(input.task, "leaseOwner");
  const abortController = new AbortController();
  let leaseActive = true;

  const handleLeaseLost = () => {
    if (!leaseActive) return;
    leaseActive = false;
    abortController.abort();
    logger.warn("Goat task lease lost", {
      event: "opencompany.goat_task_lease_lost",
      task_id: input.task.id,
    });
  };

  const heartbeat = async () => {
    const now = new Date();
    const active = await store.heartbeat({
      id: input.task.id,
      leaseId,
      leaseOwner,
      now,
      leaseExpiresAt: goatTaskLeaseExpiresAt(now, input.env.jobLeaseTtlMs),
    });
    if (!active) handleLeaseLost();
  };

  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error) => {
      captureException(error, {
        event: "opencompany.goat_task_heartbeat_failed",
        task_id: input.task.id,
      });
      logger.warn("Goat task heartbeat failed", {
        event: "opencompany.goat_task_heartbeat_failed",
        task_id: input.task.id,
        error,
      });
      handleLeaseLost();
    });
  }, GOAT_TASK_HEARTBEAT_INTERVAL_MS);

  try {
    const result = await executor({
      task: input.task,
      env: input.env,
      signal: abortController.signal,
      reportStage: async (stage, patch = {}) => {
        const active = await store.updateStage({
          id: input.task.id,
          leaseId,
          leaseOwner,
          now: new Date(),
          stage,
          ...patch,
        });
        if (!active) handleLeaseLost();
      },
    });
    if (!leaseActive) return;
    await store.complete({
      id: input.task.id,
      leaseId,
      leaseOwner,
      now: new Date(),
      result: result.result,
      harnessSpec: result.harnessSpec,
      debugTrace: result.debugTrace,
      sandboxId: result.sandboxId,
    });
  } catch (error) {
    if (leaseActive) {
      await store.fail({
        id: input.task.id,
        leaseId,
        leaseOwner,
        now: new Date(),
        error: errorMessage(error),
        ...debugTracePatch(error),
      });
    }
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export function startGoatTaskWorker(
  env: RunnerEnv,
  options: {
    store?: GoatTaskStore;
    executor?: GoatTaskExecutor;
    concurrency?: number;
    pollIntervalMs?: number;
  } = {},
) {
  const store = options.store ?? createDbGoatTaskStore();
  const executor = options.executor ?? executeGoatTask;
  const concurrency = Math.max(1, options.concurrency ?? Math.min(2, env.workerConcurrency));
  const pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 1_000);
  const active = new Set<Promise<void>>();
  let stopped = false;
  let pendingWake = false;
  let wake: (() => void) | null = null;

  const notify = () => {
    if (wake) {
      wake();
    } else {
      pendingWake = true;
    }
  };

  const waitForPollOrWake = () => {
    if (pendingWake) {
      pendingWake = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  };

  const runLoop = async () => {
    while (!stopped) {
      try {
        while (!stopped && active.size < concurrency) {
          const task = await claimNextGoatTask({
            leaseOwner: env.instanceId,
            store,
            leaseTtlMs: env.jobLeaseTtlMs,
          });
          if (!task) break;
          const running = runClaimedGoatTask({ task, env, store, executor })
            .catch((error) => {
              captureException(error, {
                event: "opencompany.goat_task_failed",
                task_id: task.id,
              });
              logger.error("Goat task failed", {
                event: "opencompany.goat_task_failed",
                task_id: task.id,
                error,
              });
            })
            .finally(() => active.delete(running));
          active.add(running);
        }
      } catch (error) {
        captureException(error, { event: "opencompany.goat_task_worker_failed" });
        logger.error("Goat task worker failed", {
          event: "opencompany.goat_task_worker_failed",
          error,
        });
      }
      if (stopped) break;
      await waitForPollOrWake();
    }
  };

  const loop = runLoop();
  return {
    notify,
    activeCount: () => active.size,
    stop: async () => {
      stopped = true;
      notify();
      await loop;
      await Promise.allSettled(Array.from(active));
    },
  };
}

function requireTaskLease(task: GoatTask, field: "leaseId" | "leaseOwner") {
  const value = task[field];
  if (!value) {
    throw new Error(`Claimed Goat task ${task.id} is missing ${field}.`);
  }
  return value;
}

function newGoatTaskLeaseId() {
  return `goat_task_${randomUUID()}`;
}

function goatTaskLeaseExpiresAt(now: Date, ttlMs: number = GOAT_TASK_LEASE_TTL_MS) {
  return new Date(now.getTime() + ttlMs);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Goat task error.";
}

const goatTaskColumnsSql = sql`
  task.id,
  task.display_id AS "displayId",
  task.name,
  task.user_workos_id AS "userWorkosId",
  task.prompt,
  task.model,
  task.status,
  task.stage,
  task.result,
  task.error,
  task.harness_spec AS "harnessSpec",
  task.debug_trace AS "debugTrace",
  task.sandbox_id AS "sandboxId",
  task.attempts,
  task.next_run_at AS "nextRunAt",
  task.lease_id AS "leaseId",
  task.lease_owner AS "leaseOwner",
  task.lease_expires_at AS "leaseExpiresAt",
  task.archived_at AS "archivedAt",
  task.created_at AS "createdAt",
  task.updated_at AS "updatedAt"
`;

type GoatTaskRow = Omit<
  GoatTask,
  "nextRunAt" | "leaseExpiresAt" | "archivedAt" | "createdAt" | "updatedAt"
> & {
  nextRunAt: Date | string;
  leaseExpiresAt: Date | string | null;
  archivedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function goatTaskFromRow(row: GoatTaskRow): GoatTask {
  return {
    ...row,
    nextRunAt: toDate(row.nextRunAt),
    leaseExpiresAt: row.leaseExpiresAt ? toDate(row.leaseExpiresAt) : null,
    archivedAt: row.archivedAt ? toDate(row.archivedAt) : null,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function errorDebugTrace(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const debugTrace = (error as { debugTrace?: unknown }).debugTrace;
  return debugTrace && typeof debugTrace === "object"
    ? (debugTrace as GoatTaskDebugTrace)
    : undefined;
}

function debugTracePatch(error: unknown) {
  const debugTrace = errorDebugTrace(error);
  return debugTrace ? { debugTrace } : {};
}
