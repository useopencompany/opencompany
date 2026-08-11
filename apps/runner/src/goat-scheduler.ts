import { randomUUID } from "node:crypto";
import { latestCronRunAt, nextCronRunAt } from "@opencompany/agent-runtime";
import {
  type CaptureGoatTaskSpawnedInput,
  captureGoatTaskSpawned,
} from "@opencompany/analytics/goat/server";
import { type Actor, TASK_WRITE_PERMISSION, TaskApplicationService } from "@opencompany/core";
import type { GoatHarnessSpec } from "@opencompany/db/goat-schema";
import { PostgresTaskRepository } from "@opencompany/db/task-repository";
import { captureException } from "@opencompany/observability";
import { type SQL, sql } from "drizzle-orm";
import { getDb } from "./db";

const GOAT_SCHEDULE_POLL_INTERVAL_MS = 30_000;

type DueScheduleRow = {
  id: string;
  userWorkosId: string;
  workspaceId: string;
  usedLegacyWorkspaceFallback: boolean;
  name: string;
  cron: string;
  timezone: string;
  prompt: string;
  plannedHarnessSpec: GoatHarnessSpec;
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
  scheduleHarnessSpec: GoatHarnessSpec;
  nextRunAt: Date | string;
};

type ScheduleTransaction = {
  execute(query: SQL): Promise<unknown>;
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
      await captureGoatTaskSpawned(result.analytics).catch((error) => {
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
  } satisfies GoatTaskScheduleWorker;
}

async function claimAndCreateOneDueScheduleRun(now: Date) {
  return getDb().transaction(async (tx) => {
    const schedule = rowsFromExecute<DueScheduleRow>(
      await tx.execute(sql`
        SELECT
          schedule.id,
          schedule.user_workos_id AS "userWorkosId",
          member.workspace_id AS "workspaceId",
          schedule.workspace_id IS NULL AS "usedLegacyWorkspaceFallback",
          schedule.name,
          schedule.cron,
          schedule.timezone,
          schedule.prompt,
          schedule.planned_harness_spec AS "plannedHarnessSpec",
          schedule.next_run_at AS "nextRunAt"
        FROM goat.task_schedules AS schedule
        INNER JOIN goat.users AS "user"
          ON "user".workos_user_id = schedule.user_workos_id
        INNER JOIN LATERAL (
          SELECT membership.workspace_id
          FROM goat.workspace_members AS membership
          WHERE membership.user_workos_id = schedule.user_workos_id
            AND (
              schedule.workspace_id IS NULL
              OR membership.workspace_id = schedule.workspace_id
            )
          ORDER BY
            CASE WHEN membership.workspace_id = schedule.workspace_id THEN 0 ELSE 1 END,
            membership.created_at ASC,
            membership.workspace_id ASC
          LIMIT 1
        ) AS member ON true
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
      workspaceId: schedule.workspaceId,
      prompt: schedule.prompt,
      name: schedule.name,
      harnessSpec: schedule.plannedHarnessSpec,
      scheduleId: schedule.id,
      scheduledFor,
      now,
    });
    if (schedule.usedLegacyWorkspaceFallback) {
      console.warn("A pre-cutover recurring Task schedule used its bounded workspace fallback.", {
        event: "opencompany.legacy_task_schedule_workspace_fallback",
        schedule_id: schedule.id,
        workspace_id: schedule.workspaceId,
      });
    }

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
    harnessSpec: GoatHarnessSpec;
    scheduleId?: string | null;
    workflowId?: string | null;
    scheduledFor: Date;
    now: Date;
  },
): Promise<CaptureGoatTaskSpawnedInput> {
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId) throw new Error("A scheduled Task requires an owning workspace.");
  const actor: Actor = {
    userId: input.userWorkosId,
    workspaceId,
    role: "member",
    permissions: [TASK_WRITE_PERMISSION],
    authenticationMethod: "service",
  };
  const repository = new PostgresTaskRepository((query) => tx.execute(query), {
    now: () => input.now,
    resolveHarness: async () => input.harnessSpec,
    compatibility: {
      initialMessageContent: input.harnessSpec.initialUserMessage.trim() || input.prompt,
    },
  });
  const created = await new TaskApplicationService(repository).createTask(actor, {
    idempotencyKey: `${input.workflowId ? "workflow" : "schedule"}:${
      input.workflowId ?? input.scheduleId
    }:${input.scheduledFor.toISOString()}`,
    name: input.name,
    goal: input.prompt,
    engine: input.harnessSpec.engine,
    model: input.harnessSpec.model,
    source: "schedule",
    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    scheduledFor: input.scheduledFor,
  });
  const task = created.task;
  return {
    userWorkosId: input.userWorkosId,
    workspaceId,
    taskId: task.id,
    displayId: task.displayId,
    engine: task.engine,
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
