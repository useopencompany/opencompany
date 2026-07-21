"use server";

import { randomUUID } from "node:crypto";
import {
  isValidFiveFieldCron,
  nextCronRunAt,
  normalizeScheduleTimezone,
} from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import type { GoatTaskScheduleRunStatus } from "@opencompany/db/goat-schema";
import { goatTaskScheduleRuns, goatTaskSchedules, goatUsers } from "@opencompany/db/goat-schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import { createGoatTaskForUser } from "@/lib/tasks";

const GOAT_TASK_SCHEDULE_PROMPT_MAX_LENGTH = 10_000;

export type GoatTaskScheduleView = {
  id: string;
  name: string;
  sourceDescription: string;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
};

export async function listCurrentUserGoatTaskSchedules(): Promise<GoatTaskScheduleView[]> {
  const { user } = await currentGoatUser();
  if (!user.taskSpawningEnabled) return [];
  const rows = await getDb()
    .select()
    .from(goatTaskSchedules)
    .where(
      and(
        eq(goatTaskSchedules.userWorkosId, user.workosUserId),
        isNull(goatTaskSchedules.deletedAt),
      ),
    )
    .orderBy(desc(goatTaskSchedules.createdAt))
    .limit(50);

  return rows.map(taskScheduleToView);
}

export async function createGoatTaskScheduleForUser(input: {
  userWorkosId: string;
  name: string;
  sourceDescription?: string;
  cron: string;
  timezone?: string | null;
  prompt: string;
  model?: AgentModelId | null;
  now?: Date;
}) {
  const parsed = parseTaskScheduleInput(input);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  if (!(await taskSpawningEnabledForUser(input.userWorkosId))) {
    throw new Error("Background tasks are disabled. Enable them in Goat Settings first.");
  }
  const now = input.now ?? new Date();
  const nextRunAt = nextCronRunAt(parsed.value.cron, parsed.value.timezone, now);
  if (!nextRunAt) {
    throw new Error("Recurring task schedule could not compute a next run.");
  }

  const schedule = await getDb().transaction(async (tx) => {
    const [user] = await tx
      .select({ enabled: goatUsers.taskSpawningEnabled })
      .from(goatUsers)
      .where(eq(goatUsers.workosUserId, input.userWorkosId))
      .limit(1)
      .for("update");
    if (!user?.enabled) {
      throw new Error("Background tasks are disabled. Enable them in Goat Settings first.");
    }

    const [created] = await tx
      .insert(goatTaskSchedules)
      .values({
        id: newGoatTaskScheduleId(),
        userWorkosId: input.userWorkosId,
        name: parsed.value.name,
        sourceDescription: parsed.value.sourceDescription,
        cron: parsed.value.cron,
        timezone: parsed.value.timezone,
        prompt: parsed.value.prompt,
        model: input.model ?? null,
        enabled: true,
        nextRunAt,
        updatedAt: now,
      })
      .returning();
    return created;
  });

  if (!schedule) throw new Error("Unable to create recurring task.");
  return schedule;
}

export async function createGoatTaskScheduleAction(input: {
  name?: string;
  cron: string;
  timezone?: string | null;
  prompt: string;
  sourceDescription?: string;
}) {
  const { user } = await currentGoatUser();
  if (!user.taskSpawningEnabled) {
    return { ok: false, error: "Background tasks are disabled." } as const;
  }
  try {
    const schedule = await createGoatTaskScheduleForUser({
      userWorkosId: user.workosUserId,
      name: input.name ?? "",
      ...(input.sourceDescription ? { sourceDescription: input.sourceDescription } : {}),
      cron: input.cron,
      timezone: input.timezone ?? null,
      prompt: input.prompt,
      model: DEFAULT_GOAT_MODEL,
    });
    return { ok: true, schedule: { id: schedule.id, name: schedule.name } } as const;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not create recurring task.",
    } as const;
  }
}

export async function setGoatTaskScheduleEnabledAction(scheduleId: string, enabled: boolean) {
  const { user } = await currentGoatUser();
  if (!user.taskSpawningEnabled) {
    return { ok: false, error: "Background tasks are disabled." } as const;
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
    : ({ ok: false, error: "Background tasks are disabled." } as const);
}

export async function updateGoatTaskScheduleAction(
  scheduleId: string,
  input: {
    name: string;
    sourceDescription?: string;
    cron: string;
    timezone?: string | null;
    prompt: string;
  },
) {
  const { user } = await currentGoatUser();
  if (!user.taskSpawningEnabled) {
    return { ok: false, error: "Background tasks are disabled." } as const;
  }
  const parsed = parseTaskScheduleInput(input);
  if (!parsed.ok) return { ok: false, error: parsed.error } as const;

  const [schedule] = await getDb()
    .select({ id: goatTaskSchedules.id })
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

  const now = new Date();
  const nextRunAt = nextCronRunAt(parsed.value.cron, parsed.value.timezone, now);
  if (!nextRunAt) {
    return { ok: false, error: "Recurring task schedule could not compute a next run." } as const;
  }

  const [updated] = await getDb()
    .update(goatTaskSchedules)
    .set({
      name: parsed.value.name,
      sourceDescription: parsed.value.sourceDescription,
      cron: parsed.value.cron,
      timezone: parsed.value.timezone,
      prompt: parsed.value.prompt,
      nextRunAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(goatTaskSchedules.id, schedule.id),
        eq(goatTaskSchedules.userWorkosId, user.workosUserId),
        isNull(goatTaskSchedules.deletedAt),
        taskSpawningEnabledForUserSql(user.workosUserId),
      ),
    )
    .returning({
      id: goatTaskSchedules.id,
      name: goatTaskSchedules.name,
      cron: goatTaskSchedules.cron,
      timezone: goatTaskSchedules.timezone,
      nextRunAt: goatTaskSchedules.nextRunAt,
    });

  if (!updated) return { ok: false, error: "Recurring task not found." } as const;
  return { ok: true, schedule: updated } as const;
}

export async function deleteGoatTaskScheduleAction(scheduleId: string) {
  const { user } = await currentGoatUser();
  if (!user.taskSpawningEnabled) {
    return { ok: false, error: "Background tasks are disabled." } as const;
  }
  const [updated] = await getDb()
    .update(goatTaskSchedules)
    .set({ enabled: false, deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(goatTaskSchedules.id, scheduleId),
        eq(goatTaskSchedules.userWorkosId, user.workosUserId),
        isNull(goatTaskSchedules.deletedAt),
        taskSpawningEnabledForUserSql(user.workosUserId),
      ),
    )
    .returning({ id: goatTaskSchedules.id });

  return updated
    ? ({ ok: true } as const)
    : ({ ok: false, error: "Recurring task not found." } as const);
}

export async function runGoatTaskScheduleNowAction(scheduleId: string) {
  const { user } = await currentGoatUser();
  if (!user.taskSpawningEnabled) {
    return { ok: false, error: "Background tasks are disabled." } as const;
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
    prompt: schedule.prompt,
    name: schedule.name,
    model: schedule.model ?? DEFAULT_GOAT_MODEL,
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

  return { ok: true, task: { id: task.id, displayId: task.displayId } } as const;
}

function taskSpawningEnabledForUserSql(userWorkosId: string) {
  return sql`EXISTS (
    SELECT 1
    FROM ${goatUsers} AS task_user
    WHERE task_user.workos_user_id = ${userWorkosId}
      AND task_user.task_spawning_enabled = true
  )`;
}

async function taskSpawningEnabledForUser(userWorkosId: string) {
  const [user] = await getDb()
    .select({ enabled: goatUsers.taskSpawningEnabled })
    .from(goatUsers)
    .where(eq(goatUsers.workosUserId, userWorkosId))
    .limit(1);
  return user?.enabled === true;
}

function parseTaskScheduleInput(input: {
  name: string;
  sourceDescription?: string;
  cron: string;
  timezone?: string | null;
  prompt: string;
}):
  | {
      ok: true;
      value: {
        name: string;
        sourceDescription: string;
        cron: string;
        timezone: string;
        prompt: string;
      };
    }
  | { ok: false; error: string } {
  const name = normalizeScheduleName(input.name, input.prompt);
  const sourceDescription = (input.sourceDescription ?? "").trim();
  const cron = input.cron.trim().replace(/\s+/g, " ");
  const timezone = normalizeScheduleTimezone(input.timezone);
  const prompt = input.prompt.trim();

  if (!prompt) return { ok: false, error: "Recurring task prompt is required." };
  if (prompt.length > GOAT_TASK_SCHEDULE_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      error: `Recurring task prompts can be at most ${GOAT_TASK_SCHEDULE_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
    };
  }
  if (!isValidFiveFieldCron(cron, timezone)) {
    return { ok: false, error: "Recurring task schedule must be a valid 5-field cron expression." };
  }

  return { ok: true, value: { name, sourceDescription, cron, timezone, prompt } };
}

function normalizeScheduleName(name: string | undefined, prompt: string) {
  const source = name?.trim() || prompt.trim().split(/\s+/).slice(0, 7).join(" ");
  const normalized = source.replace(/\s+/g, " ").trim();
  if (!normalized) return "Recurring task";
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function taskScheduleToView(row: typeof goatTaskSchedules.$inferSelect): GoatTaskScheduleView {
  return {
    id: row.id,
    name: row.name,
    sourceDescription: row.sourceDescription,
    cron: row.cron,
    timezone: row.timezone,
    prompt: row.prompt,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function insertScheduleRun(input: {
  scheduleId: string;
  userWorkosId: string;
  scheduledFor: Date;
  taskId: string | null;
  status: GoatTaskScheduleRunStatus;
  error?: string | null;
}) {
  const now = new Date();
  await getDb()
    .insert(goatTaskScheduleRuns)
    .values({
      id: newGoatTaskScheduleRunId(),
      scheduleId: input.scheduleId,
      userWorkosId: input.userWorkosId,
      scheduledFor: input.scheduledFor,
      taskId: input.taskId,
      status: input.status,
      error: input.error ?? null,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [goatTaskScheduleRuns.scheduleId, goatTaskScheduleRuns.scheduledFor],
    });
}

function newGoatTaskScheduleId() {
  return `goat_task_schedule_${randomUUID()}`;
}

function newGoatTaskScheduleRunId() {
  return `goat_task_schedule_run_${randomUUID()}`;
}
