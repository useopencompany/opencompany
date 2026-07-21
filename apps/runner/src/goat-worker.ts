import { randomUUID } from "node:crypto";
import { goatTasks } from "@opencompany/db/goat-schema";
import { GOAT_SPANS, startGoatSpan } from "@opencompany/goat-observability";
import { captureException, createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { runClaimedGoatTaskSession } from "./goat-task-session";
import { rowsFromExecute } from "./sql-exec";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-worker" });

export const GOAT_TASK_LEASE_TTL_MS = 5 * 60 * 1000;

type GoatTask = typeof goatTasks.$inferSelect;

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
};

export function createDbGoatTaskStore(): GoatTaskStore {
  return {
    async claimNext(input) {
      const result = await getDb().execute(sql`
        WITH candidate AS (
          SELECT task.id
          FROM goat.tasks AS task
          INNER JOIN goat.users AS "user"
            ON "user".workos_user_id = task.user_workos_id
          WHERE
            "user".task_spawning_enabled = true
            AND task.engine = 'opencompany'
            AND (
              (task.status = 'queued' AND task.next_run_at <= ${input.now})
              OR (task.status = 'running' AND task.lease_expires_at < ${input.now})
            )
          ORDER BY task.next_run_at ASC, task.created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE goat.tasks AS task
        SET status = 'running',
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
  const span = startGoatSpan(GOAT_SPANS.taskClaim, {
    "goat.lease_owner": input.leaseOwner,
  });
  try {
    const task = await (input.store ?? createDbGoatTaskStore()).claimNext({
      leaseId,
      leaseOwner: input.leaseOwner,
      now,
      leaseExpiresAt: goatTaskLeaseExpiresAt(now, input.leaseTtlMs),
    });
    span.end({
      "goat.lease_owner": input.leaseOwner,
      "goat.outcome": task ? "success" : "skipped",
      "goat.task_id": task?.id,
      "goat.display_id": task?.displayId,
      "goat.model": task?.model,
      "goat.status": task?.status,
    });
    return task;
  } catch (error) {
    span.fail(error, { "goat.lease_owner": input.leaseOwner });
    span.end();
    throw error;
  }
}

export function startGoatTaskWorker(
  env: RunnerEnv,
  options: {
    store?: GoatTaskStore;
    concurrency?: number;
    pollIntervalMs?: number;
  } = {},
) {
  const store = options.store ?? createDbGoatTaskStore();
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
          const running = runClaimedGoatTaskSession({ task, env, store })
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

function newGoatTaskLeaseId() {
  return `goat_task_${randomUUID()}`;
}

function goatTaskLeaseExpiresAt(now: Date, ttlMs: number = GOAT_TASK_LEASE_TTL_MS) {
  return new Date(now.getTime() + ttlMs);
}

const goatTaskColumnsSql = sql`
  task.id,
  task.display_id AS "displayId",
  task.name,
  task.user_workos_id AS "userWorkosId",
  task.prompt,
  task.model,
  task.schedule_id AS "scheduleId",
  task.scheduled_for AS "scheduledFor",
  task.engine,
  task.status,
  task.result,
  task.error,
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
  "scheduledFor" | "nextRunAt" | "leaseExpiresAt" | "archivedAt" | "createdAt" | "updatedAt"
> & {
  scheduledFor: Date | string | null;
  nextRunAt: Date | string;
  leaseExpiresAt: Date | string | null;
  archivedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function goatTaskFromRow(row: GoatTaskRow): GoatTask {
  return {
    ...row,
    scheduledFor: row.scheduledFor ? toDate(row.scheduledFor) : null,
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
