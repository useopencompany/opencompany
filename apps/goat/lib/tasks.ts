"use server";

import { randomUUID } from "node:crypto";
import { goatTaskRunSessionId } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import type { GoatHarnessEngine, GoatTask } from "@opencompany/db/goat-schema";
import {
  goatTaskEvents,
  goatTaskMessages,
  goatTaskModelUsage,
  goatTaskSandboxUsage,
  goatTasks,
  goatTaskToolUsage,
  goatUsers,
} from "@opencompany/db/goat-schema";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";
import { goatHomeActivityCutoff } from "@/lib/home-activity";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import type { GoatTaskView } from "@/lib/task-board";
import { normalizeGoatTaskName } from "@/lib/task-display";
import { triggerGoatTaskRun } from "@/lib/task-runner";
import { validateGoatTaskInput } from "@/lib/task-validation";

export type ArchiveTaskResult = {
  ok: boolean;
  error: string | null;
};

export type CreateTaskResult = { ok: true; task: GoatTaskView } | { ok: false; error: string };

export async function createGoatTaskAction(input: {
  name?: string;
  prompt: string;
}): Promise<CreateTaskResult> {
  const { user } = await currentGoatUser();
  if (!user.taskSpawningEnabled) {
    return { ok: false, error: "Background tasks are disabled." };
  }
  const validated = validateGoatTaskInput({ prompt: input.prompt, model: DEFAULT_GOAT_MODEL });
  if (!validated.ok) return { ok: false, error: validated.error };
  try {
    const task = await createGoatTaskForUser({
      userWorkosId: user.workosUserId,
      prompt: validated.value.prompt,
      model: validated.value.model,
      ...(input.name?.trim() ? { name: input.name } : {}),
    });
    return { ok: true, task: goatTaskToBoardView(task) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not create task.",
    };
  }
}

export type CancelTaskResult = {
  ok: boolean;
  error: string | null;
};

export async function listCurrentUserGoatTasks() {
  const { user } = await currentGoatUser();
  if (!user.taskSpawningEnabled) return [];
  return getDb()
    .select()
    .from(goatTasks)
    .where(
      and(
        eq(goatTasks.userWorkosId, user.workosUserId),
        isNull(goatTasks.archivedAt),
        or(
          inArray(goatTasks.status, ["queued", "running"]),
          gte(goatTasks.createdAt, goatHomeActivityCutoff()),
        ),
      ),
    )
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
  // Clearing the lease makes the runner's next lease-guarded write fail, which
  // aborts the in-flight run.
  const result = await getDb().execute(sql`
    WITH canceled_task AS (
      UPDATE goat.tasks AS task
      SET status = 'canceled',
          stage = 'canceled',
          error = 'Stopped by user.',
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${now}
      WHERE task.id = ${taskId}
        AND task.user_workos_id = ${user.workosUserId}
        AND task.status IN ('queued', 'running')
      RETURNING task.id, task.user_workos_id
    ),
    canceled_comment AS (
      INSERT INTO goat.task_comments (
        id,
        task_id,
        user_workos_id,
        author,
        kind,
        content,
        metadata,
        created_at,
        updated_at
      )
      SELECT
        ${`goat_task_comment_${randomUUID()}`},
        task.id,
        task.user_workos_id,
        'agent',
        'status',
        'Stopped by user.',
        ${JSON.stringify({ status: "canceled" })}::jsonb,
        ${now},
        ${now}
      FROM canceled_task AS task
      RETURNING id
    )
    SELECT task.id FROM canceled_task AS task
  `);

  if (rowsFromExecute<{ id: string }>(result).length === 0) {
    return { ok: false, error: "Could not stop task." };
  }

  return { ok: true, error: null };
}

export type RetryTaskResult = { ok: true } | { ok: false; error: string };

// Requeues a failed or canceled task on its existing run session; the driver
// continues the same conversation on the next claim.
export async function retryGoatTaskAction(taskId: string): Promise<RetryTaskResult> {
  if (!taskId.trim()) {
    return { ok: false, error: "Could not retry task." };
  }

  const { user } = await currentGoatUser();
  if (!user.taskSpawningEnabled) {
    return { ok: false, error: "Background tasks are disabled." };
  }
  const now = new Date();
  const result = await getDb().execute(sql`
    WITH retried_task AS (
      UPDATE goat.tasks AS task
      SET status = 'queued',
          stage = 'queued',
          error = NULL,
          next_run_at = ${now},
          updated_at = ${now}
      WHERE task.id = ${taskId}
        AND task.user_workos_id = ${user.workosUserId}
        AND task.status IN ('failed', 'canceled')
      RETURNING task.id, task.user_workos_id
    ),
    retry_comment AS (
      INSERT INTO goat.task_comments (
        id,
        task_id,
        user_workos_id,
        author,
        kind,
        content,
        metadata,
        created_at,
        updated_at
      )
      SELECT
        ${`goat_task_comment_${randomUUID()}`},
        task.id,
        task.user_workos_id,
        'agent',
        'status',
        'Retry requested.',
        ${JSON.stringify({ status: "retrying" })}::jsonb,
        ${now},
        ${now}
      FROM retried_task AS task
      RETURNING id
    )
    SELECT task.id FROM retried_task AS task
  `);

  const retried = rowsFromExecute<{ id: string }>(result)[0];
  if (!retried) return { ok: false, error: "Could not retry task." };

  try {
    await triggerGoatTaskRun(retried.id, {
      task_id: retried.id,
      event: "goat.runner_task_retry_dispatch",
    });
  } catch (error) {
    console.warn("Goat runner retry dispatch failed; the task remains queued for polling.", {
      event: "goat.runner_task_retry_dispatch_failed",
      task_id: retried.id,
      error,
    });
  }
  return { ok: true };
}

export async function createGoatTaskForUser(input: {
  userWorkosId: string;
  prompt: string;
  model: AgentModelId;
  name?: string;
  engine?: GoatHarnessEngine;
  scheduleId?: string;
  scheduledFor?: Date;
}) {
  const initialTaskSpawningState = await loadGoatTaskSpawningState(input.userWorkosId);
  if (initialTaskSpawningState === null) {
    throw new Error("Unable to create a Goat task for an unknown user.");
  }
  if (!initialTaskSpawningState) {
    throw new Error("Background tasks are disabled. Enable them in Goat Settings first.");
  }

  const id = `goat_task_${randomUUID()}`;
  const sessionId = goatTaskRunSessionId(id);
  const openingMessageId = `goat_chat_msg_${randomUUID()}`;
  const now = new Date();
  const name = normalizeGoatTaskName(input.name, input.prompt);
  // Codex-engine tasks are not unified with codex chat sessions yet; every run
  // uses the opencompany session driver until that lands.
  void input.engine;
  const engine: GoatHarnessEngine = "opencompany";
  // The run session carries the task's transcript; the opening user message is
  // the task description. Its id is deterministic so creation and the runner's
  // crash-recovery ensure step stay idempotent.
  const task = rowsFromExecute<GoatTaskRow>(
    await getDb().execute(sql`
      WITH created_task AS (
        INSERT INTO goat.tasks (
          id,
          name,
          user_workos_id,
          prompt,
          model,
          engine,
          schedule_id,
          scheduled_for,
          status,
          stage,
          next_run_at,
          created_at,
          updated_at
        )
        SELECT
          ${id},
          ${name},
          ${input.userWorkosId},
          ${input.prompt},
          ${input.model},
          ${engine},
          ${input.scheduleId ?? null},
          ${input.scheduledFor ?? null},
          'queued',
          'queued',
          ${now},
          ${now},
          ${now}
        FROM goat.users AS "user"
        WHERE "user".workos_user_id = ${input.userWorkosId}
          AND "user".task_spawning_enabled = true
        RETURNING *
      ),
      run_session AS (
        INSERT INTO goat.chat_sessions (
          id,
          user_workos_id,
          title,
          model,
          engine,
          task_id,
          created_at,
          updated_at
        )
        SELECT
          ${sessionId},
          task.user_workos_id,
          task.name,
          task.model,
          'opencompany',
          task.id,
          ${now},
          ${now}
        FROM created_task AS task
        RETURNING id
      ),
      inserted_user_message AS (
        INSERT INTO goat.chat_messages (
          id,
          session_id,
          role,
          content,
          created_at,
          updated_at
        )
        SELECT
          ${openingMessageId},
          run_session.id,
          'user',
          task.prompt,
          ${now},
          ${now}
        FROM created_task AS task
        CROSS JOIN run_session
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
        task.engine AS "engine",
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
        task.created_at AS "createdAt",
        task.updated_at AS "updatedAt"
      FROM created_task AS task
      WHERE EXISTS (SELECT 1 FROM inserted_user_message)
    `),
  ).map(goatTaskFromRow)[0];

  if (!task) {
    const currentTaskSpawningState = await loadGoatTaskSpawningState(input.userWorkosId);
    if (currentTaskSpawningState === null) {
      throw new Error("Unable to create a Goat task for an unknown user.");
    }
    if (!currentTaskSpawningState) {
      throw new Error("Background tasks are disabled. Enable them in Goat Settings first.");
    }
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

async function loadGoatTaskSpawningState(userWorkosId: string): Promise<boolean | null> {
  const [user] = await getDb()
    .select({ enabled: goatUsers.taskSpawningEnabled })
    .from(goatUsers)
    .where(eq(goatUsers.workosUserId, userWorkosId))
    .limit(1);
  return user ? user.enabled : null;
}

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

function goatTaskToBoardView(task: GoatTask): GoatTaskView {
  return {
    id: task.id,
    displayId: task.displayId,
    name: task.name,
    prompt: task.prompt,
    model: task.model,
    scheduleId: task.scheduleId,
    scheduledFor: task.scheduledFor ? task.scheduledFor.toISOString() : null,
    status: task.status,
    stage: task.stage,
    result: task.result,
    error: task.error,
    archivedAt: task.archivedAt ? task.archivedAt.toISOString() : null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

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

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
