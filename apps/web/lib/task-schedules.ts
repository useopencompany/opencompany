"use server";

import { randomUUID } from "node:crypto";
import { nextCronRunAt } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import type { GoatHarnessSpec, GoatTaskScheduleRunStatus } from "@opencompany/db/goat-schema";
import { goatTaskScheduleRuns, goatTaskSchedules } from "@opencompany/db/goat-schema";
import {
  createGoatTaskScheduleForUser as createSharedGoatTaskScheduleForUser,
  deleteGoatTaskScheduleForUser as deleteSharedGoatTaskScheduleForUser,
  listGoatTaskSchedulesForUser as listSharedGoatTaskSchedulesForUser,
  type GoatTaskScheduleView as SharedGoatTaskScheduleView,
  taskSpawningEnabledForUserSql,
  updateGoatTaskScheduleForUser as updateSharedGoatTaskScheduleForUser,
} from "@opencompany/goat-agent/task-schedules";
import { and, eq, isNull } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";
import { TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { planGoatTaskHarness } from "@/lib/task-runner";
import { createGoatTaskForUser } from "@/lib/tasks";

export type GoatTaskScheduleView = SharedGoatTaskScheduleView;

const planningDependencies = {
  planHarness: ({ actorId, prompt }: { actorId: string; prompt: string }) =>
    planGoatTaskHarness({ userWorkosId: actorId, prompt }),
};

export async function listCurrentUserGoatTaskSchedules(): Promise<GoatTaskScheduleView[]> {
  const { user } = await currentGoatUser();
  return listGoatTaskSchedulesForUser(user.workosUserId);
}

export async function listGoatTaskSchedulesForUser(userWorkosId: string) {
  return listSharedGoatTaskSchedulesForUser(userWorkosId);
}

export async function createGoatTaskScheduleForUser(input: {
  userWorkosId: string;
  workspaceId: string;
  name: string;
  sourceDescription?: string;
  cron: string;
  timezone?: string | null;
  prompt: string;
  plannedHarnessSpec?: GoatHarnessSpec;
  now?: Date;
}) {
  return createSharedGoatTaskScheduleForUser(input, planningDependencies);
}

export async function setGoatTaskScheduleEnabledAction(scheduleId: string, enabled: boolean) {
  const { user } = await currentGoatUser();
  if (!user.taskSpawningEnabled) {
    return { ok: false, error: TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } as const;
  }
  const now = new Date();
  const [schedule] = await getDb()
    .select()
    .from(goatTaskSchedules)
    .where(
      and(
        eq(goatTaskSchedules.id, scheduleId),
        eq(goatTaskSchedules.userWorkosId, user.workosUserId),
        isNull(goatTaskSchedules.deletedAt),
      ),
    )
    .limit(1);
  if (!schedule) return { ok: false, error: "Recurring task not found." } as const;

  const nextRunAt = enabled
    ? (nextCronRunAt(schedule.cron, schedule.timezone, now) ?? schedule.nextRunAt)
    : schedule.nextRunAt;
  const [updated] = await getDb()
    .update(goatTaskSchedules)
    .set({ enabled, nextRunAt, updatedAt: now })
    .where(
      and(
        eq(goatTaskSchedules.id, schedule.id),
        eq(goatTaskSchedules.userWorkosId, user.workosUserId),
        isNull(goatTaskSchedules.deletedAt),
        taskSpawningEnabledForUserSql(user.workosUserId),
      ),
    )
    .returning({ id: goatTaskSchedules.id });
  return updated
    ? ({ ok: true } as const)
    : ({ ok: false, error: TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } as const);
}

export async function updateGoatTaskScheduleAction(scheduleId: string, input: ScheduleUpdateInput) {
  const { user } = await currentGoatUser();
  return updateGoatTaskScheduleForUser(user.workosUserId, scheduleId, input);
}

export async function updateGoatTaskScheduleForUser(
  userWorkosId: string,
  scheduleId: string,
  input: ScheduleUpdateInput,
) {
  return updateSharedGoatTaskScheduleForUser(userWorkosId, scheduleId, input, planningDependencies);
}

export async function deleteGoatTaskScheduleAction(scheduleId: string) {
  const { user } = await currentGoatUser();
  return deleteGoatTaskScheduleForUser(user.workosUserId, scheduleId);
}

export async function deleteGoatTaskScheduleForUser(userWorkosId: string, scheduleId: string) {
  return deleteSharedGoatTaskScheduleForUser(userWorkosId, scheduleId);
}

export async function runGoatTaskScheduleNowAction(scheduleId: string) {
  const { user, workspace } = await currentGoatUser();
  if (!user.taskSpawningEnabled) {
    return { ok: false, error: TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } as const;
  }
  const [schedule] = await getDb()
    .select()
    .from(goatTaskSchedules)
    .where(
      and(
        eq(goatTaskSchedules.id, scheduleId),
        eq(goatTaskSchedules.userWorkosId, user.workosUserId),
        isNull(goatTaskSchedules.deletedAt),
      ),
    )
    .limit(1);
  if (!schedule) return { ok: false, error: "Recurring task not found." } as const;

  const scheduledFor = new Date();
  const task = await createGoatTaskForUser({
    userWorkosId: user.workosUserId,
    workspaceId: workspace.id,
    prompt: schedule.prompt,
    name: schedule.name,
    model: schedule.plannedHarnessSpec.model,
    harnessSpec: schedule.plannedHarnessSpec,
    scheduleId: schedule.id,
    scheduledFor,
  });
  await insertScheduleRun({
    scheduleId: schedule.id,
    userWorkosId: user.workosUserId,
    scheduledFor,
    taskId: task.id,
    status: "created",
  });
  return {
    ok: true,
    task: { id: task.id, displayId: task.displayId },
  } as const;
}

type ScheduleUpdateInput = {
  name: string;
  sourceDescription?: string;
  cron: string;
  timezone?: string | null;
  prompt: string;
};

async function insertScheduleRun(input: {
  scheduleId: string;
  userWorkosId: string;
  scheduledFor: Date;
  taskId: string | null;
  status: GoatTaskScheduleRunStatus;
  error?: string | null;
}) {
  await getDb()
    .insert(goatTaskScheduleRuns)
    .values({
      id: `goat_task_schedule_run_${randomUUID()}`,
      scheduleId: input.scheduleId,
      userWorkosId: input.userWorkosId,
      scheduledFor: input.scheduledFor,
      taskId: input.taskId,
      status: input.status,
      error: input.error ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [goatTaskScheduleRuns.scheduleId, goatTaskScheduleRuns.scheduledFor],
    });
}
