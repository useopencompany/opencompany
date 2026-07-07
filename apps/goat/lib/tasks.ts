"use server";

import { randomUUID } from "node:crypto";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import type { GoatHarnessEngine, GoatHarnessSpec, GoatTask } from "@opencompany/db/goat-schema";
import {
  goatTaskEvents,
  goatTaskMessages,
  goatTaskModelUsage,
  goatTaskSandboxUsage,
  goatTasks,
  goatTaskToolUsage,
} from "@opencompany/db/goat-schema";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";
import { getGoatAvailableHarnessTools } from "@/lib/integrations/google-data";
import { normalizeGoatTaskName } from "@/lib/task-display";
import { triggerGoatTaskRun } from "@/lib/task-runner";

export type ArchiveTaskResult = {
  ok: boolean;
  error: string | null;
};

export type CancelTaskResult = {
  ok: boolean;
  error: string | null;
};

export async function listCurrentUserGoatTasks() {
  const { user } = await currentGoatUser();
  return getDb()
    .select()
    .from(goatTasks)
    .where(and(eq(goatTasks.userWorkosId, user.workosUserId), isNull(goatTasks.archivedAt)))
    .orderBy(desc(goatTasks.createdAt))
    .limit(50);
}

export async function getCurrentUserGoatTask(taskId: string) {
  const { user } = await currentGoatUser();
  const normalizedTaskId = taskId.trim().toUpperCase();
  const [task] = await getDb()
    .select()
    .from(goatTasks)
    .where(
      and(
        eq(goatTasks.userWorkosId, user.workosUserId),
        or(eq(goatTasks.id, taskId), eq(goatTasks.displayId, normalizedTaskId)),
      ),
    )
    .limit(1);

  return task ?? null;
}

export async function getCurrentUserGoatTaskRun(taskId: string) {
  const { user } = await currentGoatUser();
  const normalizedTaskId = taskId.trim().toUpperCase();
  const [task] = await getDb()
    .select()
    .from(goatTasks)
    .where(
      and(
        eq(goatTasks.userWorkosId, user.workosUserId),
        or(eq(goatTasks.id, taskId), eq(goatTasks.displayId, normalizedTaskId)),
      ),
    )
    .limit(1);

  if (!task) return null;

  const [messages, events, modelUsage, toolUsage, sandboxUsage] = await Promise.all([
    getDb()
      .select()
      .from(goatTaskMessages)
      .where(
        and(
          eq(goatTaskMessages.userWorkosId, user.workosUserId),
          eq(goatTaskMessages.taskId, task.id),
        ),
      )
      .orderBy(asc(goatTaskMessages.createdAt)),
    getDb()
      .select()
      .from(goatTaskEvents)
      .where(
        and(eq(goatTaskEvents.userWorkosId, user.workosUserId), eq(goatTaskEvents.taskId, task.id)),
      )
      .orderBy(asc(goatTaskEvents.id)),
    getDb()
      .select()
      .from(goatTaskModelUsage)
      .where(
        and(
          eq(goatTaskModelUsage.userWorkosId, user.workosUserId),
          eq(goatTaskModelUsage.taskId, task.id),
        ),
      )
      .orderBy(asc(goatTaskModelUsage.createdAt), asc(goatTaskModelUsage.id)),
    getDb()
      .select()
      .from(goatTaskToolUsage)
      .where(
        and(
          eq(goatTaskToolUsage.userWorkosId, user.workosUserId),
          eq(goatTaskToolUsage.taskId, task.id),
        ),
      )
      .orderBy(asc(goatTaskToolUsage.createdAt), asc(goatTaskToolUsage.id)),
    getDb()
      .select()
      .from(goatTaskSandboxUsage)
      .where(
        and(
          eq(goatTaskSandboxUsage.userWorkosId, user.workosUserId),
          eq(goatTaskSandboxUsage.taskId, task.id),
        ),
      )
      .orderBy(asc(goatTaskSandboxUsage.createdAt), asc(goatTaskSandboxUsage.id)),
  ]);

  return { task, messages, events, modelUsage, toolUsage, sandboxUsage };
}

export async function archiveGoatTaskAction(taskId: string): Promise<ArchiveTaskResult> {
  if (!taskId.trim()) {
    return { ok: false, error: "Could not archive task." };
  }

  const { user } = await currentGoatUser();
  const now = new Date();
  const [task] = await getDb()
    .update(goatTasks)
    .set({
      archivedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(goatTasks.id, taskId),
        eq(goatTasks.userWorkosId, user.workosUserId),
        isNull(goatTasks.archivedAt),
        inArray(goatTasks.status, ["succeeded", "failed", "canceled"]),
      ),
    )
    .returning({ id: goatTasks.id });

  if (!task) {
    return { ok: false, error: "Could not archive task." };
  }

  return { ok: true, error: null };
}

export async function cancelGoatTaskAction(taskId: string): Promise<CancelTaskResult> {
  if (!taskId.trim()) {
    return { ok: false, error: "Could not stop task." };
  }

  const { user } = await currentGoatUser();
  const now = new Date();
  const result = await getDb().execute(sql`
    WITH canceled_task AS (
      UPDATE goat.tasks AS task
      SET status = 'canceled',
          stage = 'canceled',
          error = 'Stopped by user.',
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = ${now},
          updated_at = ${now}
      WHERE task.id = ${taskId}
        AND task.user_workos_id = ${user.workosUserId}
        AND task.status IN ('queued', 'running')
      RETURNING task.id, task.user_workos_id
    ),
    canceled_messages AS (
      UPDATE goat.task_messages AS message
      SET status = 'failed',
          model_message = COALESCE(
            message.model_message,
            jsonb_build_object(
              'role',
              message.role,
              'content',
              message.content,
              'error',
              'Stopped by user.'
            )
          ),
          updated_at = ${now},
          completed_at = ${now}
      FROM canceled_task AS task
      WHERE message.task_id = task.id
        AND message.user_workos_id = task.user_workos_id
        AND message.status = 'running'
      RETURNING message.id
    ),
    inserted_event AS (
      INSERT INTO goat.task_events (
        task_id,
        user_workos_id,
        message_id,
        type,
        payload,
        created_at
      )
      SELECT
        task.id,
        task.user_workos_id,
        NULL,
        'task.status',
        ${JSON.stringify({
          status: "canceled",
          stage: "canceled",
          error: "Stopped by user.",
        })}::jsonb,
        ${now}
      FROM canceled_task AS task
      RETURNING id
    )
    SELECT task.id
    FROM canceled_task AS task
    CROSS JOIN (SELECT count(*) FROM canceled_messages) AS message_updates
    WHERE EXISTS (SELECT 1 FROM inserted_event)
  `);

  if (rowsFromExecute<{ id: string }>(result).length === 0) {
    return { ok: false, error: "Could not stop task." };
  }

  return { ok: true, error: null };
}

export async function createGoatTaskForUser(input: {
  userWorkosId: string;
  prompt: string;
  model: AgentModelId;
  name?: string;
  engine?: GoatHarnessEngine;
  harnessSpec?: GoatHarnessSpec;
  scheduleId?: string;
  scheduledFor?: Date;
}) {
  const id = `goat_task_${randomUUID()}`;
  const userMessageId = `goat_task_msg_${randomUUID()}`;
  const now = new Date();
  const name = normalizeGoatTaskName(input.name, input.prompt);
  const tools = input.harnessSpec ? [] : await getGoatAvailableHarnessTools(input.userWorkosId);
  const harnessSpec: GoatHarnessSpec = input.harnessSpec ?? {
    schemaVersion: "goat.harness.v1",
    engine: input.engine ?? "opencompany",
    model: input.model,
    systemPrompt: "",
    initialUserMessage: input.prompt,
    tools,
    skills: [],
    maxModelSteps: 16,
    resultMode: "assistant_final",
  };
  const modelMessage = { role: "user", content: input.prompt };
  const task = rowsFromExecute<GoatTaskRow>(
    await getDb().execute(sql`
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
          ${id},
          ${name},
          ${input.userWorkosId},
          ${input.prompt},
          ${harnessSpec.model},
          ${input.scheduleId ?? null},
          ${input.scheduledFor ?? null},
          'queued',
          'queued',
          ${now},
          ${now},
          ${now},
          ${JSON.stringify(harnessSpec)}::jsonb
        )
        RETURNING *
      ),
      inserted_user_message AS (
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
          task.user_workos_id,
          'user',
          'completed',
          task.prompt,
          ${JSON.stringify(modelMessage)}::jsonb,
          ${now},
          ${now},
          ${now}
        FROM created_task AS task
        RETURNING id
      )
      SELECT
        task.id AS "id",
        task.display_id AS "displayId",
        task.name AS "name",
        task.user_workos_id AS "userWorkosId",
        task.prompt AS "prompt",
        task.model AS "model",
        task.schedule_id AS "scheduleId",
        task.scheduled_for AS "scheduledFor",
        task.status AS "status",
        task.stage AS "stage",
        task.result AS "result",
        task.error AS "error",
        task.harness_spec AS "harnessSpec",
        task.debug_trace AS "debugTrace",
        task.codex_engine_session_id AS "codexEngineSessionId",
        task.sandbox_id AS "sandboxId",
        task.attempts AS "attempts",
        task.next_run_at AS "nextRunAt",
        task.lease_id AS "leaseId",
        task.lease_owner AS "leaseOwner",
        task.lease_expires_at AS "leaseExpiresAt",
        task.archived_at AS "archivedAt",
        task.started_at AS "startedAt",
        task.completed_at AS "completedAt",
        task.created_at AS "createdAt",
        task.updated_at AS "updatedAt"
      FROM created_task AS task
      WHERE EXISTS (SELECT 1 FROM inserted_user_message)
    `),
  ).map(goatTaskFromRow)[0];

  if (!task) {
    throw new Error("Unable to create Goat task.");
  }

  try {
    await triggerGoatTaskRun(id, {
      task_id: id,
      event: "goat.runner_task_created_dispatch",
    });
  } catch (error) {
    console.warn("Goat runner dispatch failed; the task remains queued for polling.", {
      event: "goat.runner_task_created_dispatch_failed",
      task_id: id,
      error,
    });
  }

  return task;
}

type GoatTaskRow = Omit<
  GoatTask,
  | "scheduledFor"
  | "nextRunAt"
  | "leaseExpiresAt"
  | "archivedAt"
  | "startedAt"
  | "completedAt"
  | "createdAt"
  | "updatedAt"
> & {
  scheduledFor: Date | string | null;
  nextRunAt: Date | string;
  leaseExpiresAt: Date | string | null;
  archivedAt: Date | string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
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
    startedAt: row.startedAt ? toDate(row.startedAt) : null,
    completedAt: row.completedAt ? toDate(row.completedAt) : null,
    createdAt: toDate(row.createdAt),
    updatedAt: toDate(row.updatedAt),
  };
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
