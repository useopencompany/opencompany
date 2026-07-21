"use server";

import { randomUUID } from "node:crypto";
import { codexCliModelNameForModelId, goatTaskRunSessionId } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import type { GoatHarnessEngine, GoatTask } from "@opencompany/db/goat-schema";
import { goatTasks, goatUsers } from "@opencompany/db/goat-schema";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";
import { nextGoatChatMessageCreatedAt } from "@/lib/chat-ui";
import { isGoatCodexConnectedForUser } from "@/lib/codex-auth";
import { normalizeCodexChatModelId } from "@/lib/codex-chat-constants";
import { goatHomeActivityCutoff } from "@/lib/home-activity";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";
import type { GoatTaskView } from "@/lib/task-board";
import { normalizeGoatTaskName } from "@/lib/task-display";
import { triggerGoatCodexChatWake, triggerGoatTaskRun } from "@/lib/task-runner";
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
  // Codex tasks are driven by the codex chat worker; requeueing one for the
  // task worker would strand it as a zombie the worker never claims.
  const [existing] = await getDb()
    .select({ engine: goatTasks.engine })
    .from(goatTasks)
    .where(and(eq(goatTasks.id, taskId), eq(goatTasks.userWorkosId, user.workosUserId)))
    .limit(1);
  if (existing?.engine === "codex") {
    return { ok: false, error: "Codex tasks cannot be retried yet. Start a new task instead." };
  }
  const now = new Date();
  const result = await getDb().execute(sql`
    WITH retried_task AS (
      UPDATE goat.tasks AS task
      SET status = 'queued',
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

  const engine: GoatHarnessEngine = input.engine ?? "opencompany";
  if (engine === "codex" && !(await isGoatCodexConnectedForUser(input.userWorkosId))) {
    throw new Error("Connect Codex in Goat settings before starting a Codex task.");
  }

  const id = `goat_task_${randomUUID()}`;
  const sessionId = goatTaskRunSessionId(id);
  const openingMessageId = `goat_chat_msg_${randomUUID()}`;
  const now = new Date();
  const name = normalizeGoatTaskName(input.name, input.prompt);
  // The run session carries the task's transcript; the opening user message is
  // the task description. The session id is deterministic so creation, the
  // runner's crash-recovery ensure step, and every task-to-session link stay
  // idempotent. Codex tasks are driven by the codex chat worker via a queued
  // codex turn; opencompany tasks are claimed by the task worker.
  const task =
    engine === "codex"
      ? await insertCodexTaskRunGraph({ ...input, id, sessionId, openingMessageId, now, name })
      : await insertOpenCompanyTaskRunGraph({
          ...input,
          id,
          sessionId,
          openingMessageId,
          now,
          name,
        });

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

  if (engine === "codex") {
    // Best-effort nudge; the codex chat worker's poll loop picks the turn up regardless.
    await triggerGoatCodexChatWake().catch((error) => {
      console.warn("Goat codex chat wake failed; the task turn waits for polling.", {
        event: "goat.codex_chat_wake_failed",
        task_id: id,
        error,
      });
    });
    return task;
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

type CreateGoatTaskGraphInput = {
  id: string;
  sessionId: string;
  openingMessageId: string;
  now: Date;
  name: string;
  userWorkosId: string;
  prompt: string;
  model: AgentModelId;
  scheduleId?: string;
  scheduledFor?: Date;
};

async function insertOpenCompanyTaskRunGraph(input: CreateGoatTaskGraphInput) {
  const { id, sessionId, openingMessageId, now, name } = input;
  return rowsFromExecute<GoatTaskRow>(
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
          'opencompany',
          ${input.scheduleId ?? null},
          ${input.scheduledFor ?? null},
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
        task.result AS "result",
        task.error AS "error",
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
}

// Mirrors the CTE shape of createFirstCodexChatTurn in @/lib/codex-chat: the
// run session doubles as a codex chat session with the opening user message,
// an empty assistant placeholder, and one queued codex turn seeded with the
// task prompt. The codex chat worker claims the turn and streams into the
// placeholder; the runner's settle hook mirrors the outcome onto the task.
async function insertCodexTaskRunGraph(input: CreateGoatTaskGraphInput) {
  const { id, sessionId, openingMessageId, now, name } = input;
  const codexChatSessionId = `goat_codex_chat_${randomUUID()}`;
  const turnId = `goat_codex_chat_turn_${randomUUID()}`;
  const assistantMessageId = `goat_chat_msg_${randomUUID()}`;
  const assistantCreatedAt = nextGoatChatMessageCreatedAt(now);
  const modelId = normalizeCodexChatModelId(input.model);
  const codexModel = codexCliModelNameForModelId(modelId);
  if (!codexModel) throw new Error(`Unsupported Codex model: ${modelId}`);
  // Same placeholder trace shape createFirstCodexChatTurn writes.
  const assistantDebugTrace = {
    schemaVersion: "goat.codex_chat.debug.v1",
    model: codexModel,
    uiMessageParts: [],
  };

  return rowsFromExecute<GoatTaskRow>(
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
          next_run_at,
          created_at,
          updated_at
        )
        SELECT
          ${id},
          ${name},
          ${input.userWorkosId},
          ${input.prompt},
          ${modelId},
          'codex',
          ${input.scheduleId ?? null},
          ${input.scheduledFor ?? null},
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
          'codex',
          task.id,
          ${now},
          ${assistantCreatedAt}
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
      ),
      inserted_assistant_message AS (
        INSERT INTO goat.chat_messages (
          id,
          session_id,
          role,
          content,
          debug_trace,
          created_at,
          updated_at
        )
        SELECT
          ${assistantMessageId},
          run_session.id,
          'assistant',
          '',
          ${JSON.stringify(assistantDebugTrace)}::jsonb,
          ${assistantCreatedAt},
          ${assistantCreatedAt}
        FROM run_session
        RETURNING id
      ),
      inserted_codex_session AS (
        INSERT INTO goat.codex_chat_sessions (
          id,
          user_workos_id,
          chat_session_id,
          model,
          active_turn_id,
          status,
          created_at,
          updated_at
        )
        SELECT
          ${codexChatSessionId},
          task.user_workos_id,
          run_session.id,
          ${codexModel},
          ${turnId},
          'queued',
          ${now},
          ${now}
        FROM created_task AS task
        CROSS JOIN run_session
        RETURNING id
      ),
      inserted_turn AS (
        INSERT INTO goat.codex_chat_turns (
          id,
          user_workos_id,
          codex_chat_session_id,
          chat_session_id,
          user_message_id,
          assistant_message_id,
          status,
          prompt,
          settings,
          created_at,
          updated_at
        )
        SELECT
          ${turnId},
          task.user_workos_id,
          codex_session.id,
          run_session.id,
          ${openingMessageId},
          ${assistantMessageId},
          'queued',
          task.prompt,
          '{}'::jsonb,
          ${now},
          ${now}
        FROM created_task AS task
        CROSS JOIN run_session
        CROSS JOIN inserted_codex_session AS codex_session
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
        task.result AS "result",
        task.error AS "error",
        task.attempts AS "attempts",
        task.next_run_at AS "nextRunAt",
        task.lease_id AS "leaseId",
        task.lease_owner AS "leaseOwner",
        task.lease_expires_at AS "leaseExpiresAt",
        task.archived_at AS "archivedAt",
        task.created_at AS "createdAt",
        task.updated_at AS "updatedAt"
      FROM created_task AS task
      WHERE EXISTS (SELECT 1 FROM inserted_turn)
    `),
  ).map(goatTaskFromRow)[0];
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
    engine: task.engine,
    status: task.status,
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
