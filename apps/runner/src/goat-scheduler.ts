import { randomUUID } from "node:crypto";
import { latestCronRunAt, nextCronRunAt } from "@opencompany/agent-runtime";
import type { GoatHarnessSpec } from "@opencompany/db/goat-schema";
import { sql } from "drizzle-orm";
import { getDb } from "./db";

const GOAT_SCHEDULE_POLL_INTERVAL_MS = 30_000;

type DueScheduleRow = {
  id: string;
  userWorkosId: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  plannedHarnessSpec: GoatHarnessSpec;
  nextRunAt: Date | string;
};

export type GoatTaskScheduleWorker = {
  notify: () => void;
  stop: () => Promise<void>;
};

export async function sweepDueGoatTaskSchedules(
  input: { now?: Date; onTaskCreated?: () => void } = {},
) {
  const now = input.now ?? new Date();
  let created = 0;
  let checked = 0;

  while (true) {
    const result = await claimAndCreateOneDueScheduleRun(now);
    if (result.status === "none") break;
    checked += 1;
    if (result.status === "created") {
      created += 1;
      input.onTaskCreated?.();
    }
  }

  return { checked, created };
}

export function startGoatTaskScheduleWorker(input: { onTaskCreated?: () => void } = {}) {
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
      }, GOAT_SCHEDULE_POLL_INTERVAL_MS);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  };

  const loop = (async () => {
    while (!stopped) {
      await sweepDueGoatTaskSchedules({
        ...(input.onTaskCreated ? { onTaskCreated: input.onTaskCreated } : {}),
      }).catch((error) => {
        console.error("Goat task schedule sweep failed.", {
          event: "opencompany.goat_task_schedule_sweep_failed",
          error,
        });
      });
      if (!stopped) await waitForPollOrWake();
    }
  })();

  return {
    notify,
    stop: async () => {
      stopped = true;
      notify();
      await loop;
    },
  } satisfies GoatTaskScheduleWorker;
}

async function claimAndCreateOneDueScheduleRun(now: Date) {
  return getDb().transaction(async (tx) => {
    const schedule = rowsFromExecute<DueScheduleRow>(
      await tx.execute(sql`
        SELECT
          id,
          user_workos_id AS "userWorkosId",
          name,
          cron,
          timezone,
          prompt,
          planned_harness_spec AS "plannedHarnessSpec",
          next_run_at AS "nextRunAt"
        FROM goat.task_schedules AS schedule
        INNER JOIN goat.users AS "user"
          ON "user".workos_user_id = schedule.user_workos_id
        WHERE schedule.enabled = true
          AND schedule.deleted_at IS NULL
          AND schedule.next_run_at <= ${now}
          AND "user".task_spawning_enabled = true
        ORDER BY schedule.next_run_at ASC, schedule.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `),
    )[0];

    if (!schedule) return { status: "none" as const };

    const nextRunAt = toDate(schedule.nextRunAt);
    const scheduledFor = latestCronRunAt(schedule.cron, schedule.timezone, now) ?? nextRunAt;
    const futureRunAt = nextCronRunAt(schedule.cron, schedule.timezone, now);
    if (!futureRunAt) {
      await tx.execute(sql`
        UPDATE goat.task_schedules
        SET enabled = false,
            updated_at = ${now}
        WHERE id = ${schedule.id}
      `);
      return { status: "failed" as const };
    }

    const runId = `goat_task_schedule_run_${randomUUID()}`;
    const insertedRun = rowsFromExecute<{ id: string }>(
      await tx.execute(sql`
        INSERT INTO goat.task_schedule_runs (
          id,
          schedule_id,
          user_workos_id,
          scheduled_for,
          status,
          created_at,
          updated_at
        )
        VALUES (
          ${runId},
          ${schedule.id},
          ${schedule.userWorkosId},
          ${scheduledFor},
          'pending',
          ${now},
          ${now}
        )
        ON CONFLICT (schedule_id, scheduled_for) DO NOTHING
        RETURNING id
      `),
    )[0];

    if (!insertedRun) {
      await tx.execute(sql`
        UPDATE goat.task_schedules
        SET next_run_at = ${futureRunAt},
            updated_at = ${now}
        WHERE id = ${schedule.id}
      `);
      return { status: "duplicate" as const };
    }

    const taskId = `goat_task_${randomUUID()}`;
    const userMessageId = `goat_task_msg_${randomUUID()}`;
    const modelMessage = { role: "user", content: schedule.prompt };
    const harnessSpec = schedule.plannedHarnessSpec;

    await tx.execute(sql`
      WITH created_task AS (
        INSERT INTO goat.tasks (
          id,
          name,
          user_workos_id,
          prompt,
          model,
          schedule_id,
          scheduled_for,
          status,
          stage,
          next_run_at,
          created_at,
          updated_at,
          harness_spec
        )
        VALUES (
          ${taskId},
          ${schedule.name},
          ${schedule.userWorkosId},
          ${schedule.prompt},
          ${harnessSpec.model},
          ${schedule.id},
          ${scheduledFor},
          'queued',
          'queued',
          ${now},
          ${now},
          ${now},
          ${JSON.stringify(harnessSpec)}::jsonb
        )
        RETURNING id
      ),
      inserted_message AS (
        INSERT INTO goat.task_messages (
          id,
          task_id,
          user_workos_id,
          role,
          status,
          content,
          model_message,
          created_at,
          updated_at,
          completed_at
        )
        SELECT
          ${userMessageId},
          task.id,
          ${schedule.userWorkosId},
          'user',
          'completed',
          ${schedule.prompt},
          ${JSON.stringify(modelMessage)}::jsonb,
          ${now},
          ${now},
          ${now}
        FROM created_task AS task
      )
      UPDATE goat.task_schedule_runs
      SET status = 'created',
          task_id = ${taskId},
          updated_at = ${now}
      WHERE id = ${runId}
    `);

    await tx.execute(sql`
      UPDATE goat.task_schedules
      SET last_run_at = ${scheduledFor},
          next_run_at = ${futureRunAt},
          updated_at = ${now}
      WHERE id = ${schedule.id}
    `);

    return { status: "created" as const, taskId };
  });
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}
