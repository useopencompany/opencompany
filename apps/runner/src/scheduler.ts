import { randomUUID } from "node:crypto";
import { latestCronRunAt, nextCronRunAt } from "@opencompany/agent-runtime";
import { type CaptureTaskSpawnedInput, captureTaskSpawned } from "@opencompany/analytics/server";
import type { HarnessSpec } from "@opencompany/db/schema";
import { createTaskSession } from "@opencompany/db/task-sessions";
import { captureException } from "@opencompany/observability";
import { type SQL, sql } from "drizzle-orm";
import { getDb } from "./db";

const GOAT_SCHEDULE_POLL_INTERVAL_MS = 30_000;

type DueScheduleRow = {
  id: string;
  userWorkosId: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  plannedHarnessSpec: HarnessSpec;
  nextRunAt: Date | string;
};

type DueWorkflowScheduleRow = {
  id: string;
  workspaceId: string;
  slug: string;
  userWorkosId: string;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  scheduleHarnessSpec: HarnessSpec;
  nextRunAt: Date | string;
};

type ScheduleTransaction = {
  execute(query: SQL): Promise<unknown>;
};

export type TaskScheduleWorker = {
  notify: () => void;
  stop: () => Promise<void>;
};

export async function sweepDueTaskSchedules(
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
      await captureTaskSpawned(result.analytics).catch((error) => {
        console.warn("Goat scheduled task spawned analytics failed.", {
          event: "goat.scheduled_task_spawned_analytics_failed",
          task_id: result.taskId,
          error,
        });
      });
    }
  }

  return { checked, created };
}

export function startTaskScheduleWorker(input: { onTaskCreated?: () => void } = {}) {
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
      await sweepDueTaskSchedules({
        ...(input.onTaskCreated ? { onTaskCreated: input.onTaskCreated } : {}),
      }).catch((error) => {
        captureException(error, { event: "opencompany.goat_task_schedule_sweep_failed" });
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
  } satisfies TaskScheduleWorker;
}

async function claimAndCreateOneDueScheduleRun(now: Date) {
  return getDb().transaction(async (tx) => {
    const schedule = rowsFromExecute<DueScheduleRow>(
      await tx.execute(sql`
        SELECT
          schedule.id,
          schedule.user_workos_id AS "userWorkosId",
          schedule.name,
          schedule.cron,
          schedule.timezone,
          schedule.prompt,
          schedule.planned_harness_spec AS "plannedHarnessSpec",
          schedule.next_run_at AS "nextRunAt"
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

    if (!schedule) {
      const workflow = rowsFromExecute<DueWorkflowScheduleRow>(
        await tx.execute(sql`
          SELECT
            workflow.id,
            workflow.workspace_id AS "workspaceId",
            workflow.slug,
            workflow.schedule_user_workos_id AS "userWorkosId",
            workflow.name,
            workflow.schedule_cron AS "cron",
            workflow.schedule_timezone AS "timezone",
            workflow.schedule_prompt AS "prompt",
            workflow.schedule_harness_spec AS "scheduleHarnessSpec",
            workflow.schedule_next_run_at AS "nextRunAt"
          FROM goat.workflows AS workflow
          INNER JOIN goat.users AS "user"
            ON "user".workos_user_id = workflow.schedule_user_workos_id
          INNER JOIN goat.workspace_members AS member
            ON member.workspace_id = workflow.workspace_id
           AND member.user_workos_id = "user".workos_user_id
          WHERE workflow.trigger = 'schedule'
            AND workflow.schedule_enabled = true
            AND workflow.status = 'active'
            AND workflow.archived_at IS NULL
            AND workflow.schedule_next_run_at <= ${now}
            AND workflow.schedule_cron IS NOT NULL
            AND workflow.schedule_harness_spec IS NOT NULL
            AND "user".task_spawning_enabled = true
          ORDER BY workflow.schedule_next_run_at ASC, workflow.updated_at ASC
          FOR UPDATE OF workflow SKIP LOCKED
          LIMIT 1
        `),
      )[0];

      if (!workflow) return { status: "none" as const };

      const nextRunAt = toDate(workflow.nextRunAt);
      const scheduledFor = latestCronRunAt(workflow.cron, workflow.timezone, now) ?? nextRunAt;
      const futureRunAt = nextCronRunAt(workflow.cron, workflow.timezone, now);
      if (!futureRunAt) {
        await tx.execute(sql`
          UPDATE goat.workflows
          SET schedule_enabled = false,
              updated_at = ${now}
          WHERE id = ${workflow.id}
        `);
        return { status: "failed" as const };
      }

      const runId = `goat_workflow_schedule_run_${randomUUID()}`;
      const insertedRun = rowsFromExecute<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO goat.workflow_schedule_runs (
            id,
            workflow_id,
            workspace_id,
            user_workos_id,
            scheduled_for,
            status,
            created_at,
            updated_at
          )
          VALUES (
            ${runId},
            ${workflow.id},
            ${workflow.workspaceId},
            ${workflow.userWorkosId},
            ${scheduledFor},
            'pending',
            ${now},
            ${now}
          )
          ON CONFLICT (workflow_id, scheduled_for) DO NOTHING
          RETURNING id
        `),
      )[0];

      if (!insertedRun) {
        await tx.execute(sql`
          UPDATE goat.workflows
          SET schedule_next_run_at = ${futureRunAt},
              updated_at = ${now}
          WHERE id = ${workflow.id}
        `);
        return { status: "duplicate" as const };
      }

      const createdTask = await createScheduledTask(tx, {
        userWorkosId: workflow.userWorkosId,
        workspaceId: workflow.workspaceId,
        prompt: workflow.prompt,
        name: workflow.name,
        harnessSpec: workflow.scheduleHarnessSpec,
        workflowId: workflow.slug,
        scheduledFor,
        now,
      });

      await tx.execute(sql`
        UPDATE goat.workflow_schedule_runs
        SET status = 'created',
            task_id = ${createdTask.taskId},
            updated_at = ${now}
        WHERE id = ${runId}
      `);

      await tx.execute(sql`
        UPDATE goat.workflows
        SET schedule_last_run_at = ${scheduledFor},
            schedule_next_run_at = ${futureRunAt},
            updated_at = ${now}
        WHERE id = ${workflow.id}
      `);

      return {
        status: "created" as const,
        taskId: createdTask.taskId,
        analytics: createdTask,
      };
    }

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

    const createdTask = await createScheduledTask(tx, {
      userWorkosId: schedule.userWorkosId,
      prompt: schedule.prompt,
      name: schedule.name,
      harnessSpec: schedule.plannedHarnessSpec,
      scheduleId: schedule.id,
      scheduledFor,
      now,
    });

    await tx.execute(sql`
      UPDATE goat.task_schedule_runs
      SET status = 'created',
          task_id = ${createdTask.taskId},
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

    return {
      status: "created" as const,
      taskId: createdTask.taskId,
      analytics: createdTask,
    };
  });
}

async function createScheduledTask(
  tx: ScheduleTransaction,
  input: {
    userWorkosId: string;
    workspaceId?: string | null;
    prompt: string;
    name: string;
    harnessSpec: HarnessSpec;
    scheduleId?: string | null;
    workflowId?: string | null;
    scheduledFor: Date;
    now: Date;
  },
): Promise<CaptureTaskSpawnedInput> {
  const task = await createTaskSession(
    {
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId ?? null,
      prompt: input.prompt,
      name: input.name,
      harnessSpec: input.harnessSpec,
      scheduleId: input.scheduleId ?? null,
      scheduledFor: input.scheduledFor,
      workflowId: input.workflowId ?? null,
      now: input.now,
    },
    tx,
  );
  return {
    userWorkosId: task.userWorkosId,
    workspaceId: input.workspaceId ?? task.harnessSpec.workflow?.workspaceId ?? null,
    taskId: task.id,
    displayId: task.displayId,
    engine: task.harnessSpec.engine,
    model: task.model,
    workflowId: task.workflowId,
    scheduleId: task.scheduleId,
    trigger: "schedule",
  };
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
