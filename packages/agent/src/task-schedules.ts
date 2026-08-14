import { randomUUID } from "node:crypto";
import {
  isValidFiveFieldCron,
  nextCronRunAt,
  normalizeScheduleTimezone,
} from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import type { HarnessSpec } from "@opencompany/db/product-schema";
import { taskSchedules, users } from "@opencompany/db/product-schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } from "./feature-flags";

const TASK_SCHEDULE_PROMPT_MAX_LENGTH = 10_000;

export type TaskScheduleView = {
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

export async function listTaskSchedulesForUser(userWorkosId: string): Promise<TaskScheduleView[]> {
  if (!(await taskSpawningEnabledForUser(userWorkosId))) return [];
  const rows = await getDb()
    .select()
    .from(taskSchedules)
    .where(and(eq(taskSchedules.userWorkosId, userWorkosId), isNull(taskSchedules.deletedAt)))
    .orderBy(desc(taskSchedules.createdAt))
    .limit(50);

  return rows.map(taskScheduleToView);
}

export async function createTaskScheduleForUser(
  input: {
    userWorkosId: string;
    workspaceId: string;
    name: string;
    sourceDescription?: string;
    cron: string;
    timezone?: string | null;
    prompt: string;
    plannedHarnessSpec?: HarnessSpec;
    now?: Date;
  },
  dependencies: {
    planHarness: (input: { actorId: string; prompt: string }) => Promise<HarnessSpec>;
  },
) {
  const parsed = parseTaskScheduleInput(input);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  if (!(await taskSpawningEnabledForUser(input.userWorkosId))) {
    throw new Error(TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE);
  }
  const now = input.now ?? new Date();
  const plannedHarnessSpec =
    input.plannedHarnessSpec ??
    (await dependencies.planHarness({
      actorId: input.userWorkosId,
      prompt: parsed.value.prompt,
    }));
  const nextRunAt = nextCronRunAt(parsed.value.cron, parsed.value.timezone, now);
  if (!nextRunAt) {
    throw new Error("Recurring task schedule could not compute a next run.");
  }

  const scheduleId = newTaskScheduleId();
  const result = await getDb().execute(sql`
    WITH enabled_actor AS MATERIALIZED (
      SELECT task_user.workos_user_id, member.workspace_id
      FROM goat.users AS task_user
      JOIN goat.workspace_members AS member
        ON member.user_workos_id = task_user.workos_user_id
       AND member.workspace_id = ${input.workspaceId}
      WHERE task_user.workos_user_id = ${input.userWorkosId}
        AND task_user.task_spawning_enabled = true
      FOR UPDATE OF task_user
    )
    INSERT INTO goat.task_schedules (
      id,
      user_workos_id,
      workspace_id,
      name,
      source_description,
      cron,
      timezone,
      prompt,
      planned_harness_spec,
      enabled,
      next_run_at,
      created_at,
      updated_at
    )
    SELECT
      ${scheduleId},
      enabled_actor.workos_user_id,
      enabled_actor.workspace_id,
      ${parsed.value.name},
      ${parsed.value.sourceDescription},
      ${parsed.value.cron},
      ${parsed.value.timezone},
      ${parsed.value.prompt},
      ${JSON.stringify(plannedHarnessSpec)}::jsonb,
      true,
      ${nextRunAt},
      ${now},
      ${now}
    FROM enabled_actor
    RETURNING id
  `);

  const [schedule] = rowsFromExecute<{ id: string }>(result);
  if (!schedule) {
    throw new Error(TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE);
  }
  return {
    id: schedule.id,
    userWorkosId: input.userWorkosId,
    workspaceId: input.workspaceId,
    name: parsed.value.name,
    sourceDescription: parsed.value.sourceDescription,
    cron: parsed.value.cron,
    timezone: parsed.value.timezone,
    prompt: parsed.value.prompt,
    plannedHarnessSpec,
    enabled: true,
    lastRunAt: null,
    nextRunAt,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateTaskScheduleForUser(
  userWorkosId: string,
  scheduleId: string,
  input: {
    name: string;
    sourceDescription?: string;
    cron: string;
    timezone?: string | null;
    prompt: string;
  },
  dependencies: {
    planHarness: (input: { actorId: string; prompt: string }) => Promise<HarnessSpec>;
  },
) {
  if (!(await taskSpawningEnabledForUser(userWorkosId))) {
    return { ok: false, error: TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } as const;
  }
  const parsed = parseTaskScheduleInput(input);
  if (!parsed.ok) return { ok: false, error: parsed.error } as const;

  const [schedule] = await getDb()
    .select({ id: taskSchedules.id })
    .from(taskSchedules)
    .where(
      and(
        eq(taskSchedules.id, scheduleId),
        eq(taskSchedules.userWorkosId, userWorkosId),
        isNull(taskSchedules.deletedAt),
      ),
    )
    .limit(1);
  if (!schedule) return { ok: false, error: "Recurring task not found." } as const;

  const now = new Date();
  const nextRunAt = nextCronRunAt(parsed.value.cron, parsed.value.timezone, now);
  if (!nextRunAt) {
    return { ok: false, error: "Recurring task schedule could not compute a next run." } as const;
  }

  const plannedHarnessSpec = await dependencies.planHarness({
    actorId: userWorkosId,
    prompt: parsed.value.prompt,
  });

  const [updated] = await getDb()
    .update(taskSchedules)
    .set({
      name: parsed.value.name,
      sourceDescription: parsed.value.sourceDescription,
      cron: parsed.value.cron,
      timezone: parsed.value.timezone,
      prompt: parsed.value.prompt,
      plannedHarnessSpec,
      nextRunAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(taskSchedules.id, schedule.id),
        eq(taskSchedules.userWorkosId, userWorkosId),
        isNull(taskSchedules.deletedAt),
        taskSpawningEnabledForUserSql(userWorkosId),
      ),
    )
    .returning({
      id: taskSchedules.id,
      name: taskSchedules.name,
      cron: taskSchedules.cron,
      timezone: taskSchedules.timezone,
      nextRunAt: taskSchedules.nextRunAt,
    });

  if (!updated) return { ok: false, error: "Recurring task not found." } as const;
  return { ok: true, schedule: updated } as const;
}

export async function deleteTaskScheduleForUser(userWorkosId: string, scheduleId: string) {
  if (!(await taskSpawningEnabledForUser(userWorkosId))) {
    return { ok: false, error: TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } as const;
  }
  const [updated] = await getDb()
    .update(taskSchedules)
    .set({ enabled: false, deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(taskSchedules.id, scheduleId),
        eq(taskSchedules.userWorkosId, userWorkosId),
        isNull(taskSchedules.deletedAt),
        taskSpawningEnabledForUserSql(userWorkosId),
      ),
    )
    .returning({ id: taskSchedules.id });

  return updated
    ? ({ ok: true } as const)
    : ({ ok: false, error: "Recurring task not found." } as const);
}

export function taskSpawningEnabledForUserSql(userWorkosId: string) {
  return sql`EXISTS (
    SELECT 1
    FROM ${users} AS task_user
    WHERE task_user.workos_user_id = ${userWorkosId}
      AND task_user.task_spawning_enabled = true
  )`;
}

async function taskSpawningEnabledForUser(userWorkosId: string) {
  const [user] = await getDb()
    .select({ enabled: users.taskSpawningEnabled })
    .from(users)
    .where(eq(users.workosUserId, userWorkosId))
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
  if (prompt.length > TASK_SCHEDULE_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      error: `Recurring task prompts can be at most ${TASK_SCHEDULE_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
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

function taskScheduleToView(row: typeof taskSchedules.$inferSelect): TaskScheduleView {
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

function newTaskScheduleId() {
  return `goat_task_schedule_${randomUUID()}`;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
