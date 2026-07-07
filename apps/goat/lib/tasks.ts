"use server";

import { randomUUID } from "node:crypto";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import type {
  GoatHarnessEngine,
  GoatHarnessSpec,
  GoatTask,
  GoatTaskDebugTrace,
  GoatTaskEventPayload,
  GoatTaskEventType,
  GoatTaskMessageRole,
  GoatTaskMessageStatus,
  GoatTaskStage,
  GoatTaskStatus,
  GoatTaskToolName,
} from "@opencompany/db/goat-schema";
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

export const GOAT_TASK_CONTINUATION_MAX_CHARS = 8_000;

const RECENT_TRANSCRIPT_LIMIT = 16;
const RECENT_EVENT_LIMIT = 12;
const MESSAGE_CONTEXT_MAX_CHARS = 1_200;
const RESULT_CONTEXT_MAX_CHARS = 6_000;
const ERROR_CONTEXT_MAX_CHARS = 2_000;
const EVENT_CONTEXT_MAX_CHARS = 700;

export type ArchiveTaskResult = {
  ok: boolean;
  error: string | null;
};

export type CancelTaskResult = {
  ok: boolean;
  error: string | null;
};

export type ContinueTaskResult =
  | { ok: true; taskId: string; displayId: string; messageId: string }
  | { ok: false; error: string };

type Db = Pick<ReturnType<typeof getDb>, "execute">;

type ContinueTaskRow = {
  id: string;
  displayId: string;
  name: string;
  userWorkosId: string;
  prompt: string;
  model: string;
  status: GoatTaskStatus;
  stage: GoatTaskStage;
  result: string | null;
  error: string | null;
  harnessSpec: unknown;
  debugTrace: GoatTaskDebugTrace;
  codexEngineSessionId: string | null;
  sandboxId: string | null;
  attempts: number;
  nextRunAt: Date | string;
  leaseId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | string | null;
  archivedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type GoatTaskContinuationMessageRow = {
  id: string;
  role: GoatTaskMessageRole;
  status: GoatTaskMessageStatus;
  content: string;
  modelMessage: unknown;
  toolName: GoatTaskToolName | null;
  toolCallId: string | null;
  responseToMessageId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  completedAt: Date | string | null;
};

export type GoatTaskContinuationEventRow = {
  id: number;
  messageId: string | null;
  type: GoatTaskEventType;
  payload: GoatTaskEventPayload;
  createdAt: Date | string;
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

export async function continueGoatTaskAction(
  taskDisplayIdOrId: string,
  content: string,
): Promise<ContinueTaskResult> {
  const { user } = await currentGoatUser();
  return continueGoatTaskForActor({
    actor: "human",
    taskDisplayIdOrId,
    content,
    userWorkosId: user.workosUserId,
    wakeRunner: async (taskId) => {
      await triggerGoatTaskRun(taskId, {
        task_id: taskId,
        event: "goat.runner_task_continued_dispatch",
      });
    },
  });
}

export async function continueGoatTaskForActor(input: {
  actor: "human";
  taskDisplayIdOrId: string;
  content: string;
  userWorkosId: string;
  db?: Db;
  now?: Date;
  wakeRunner?: (taskId: string) => Promise<void>;
}): Promise<ContinueTaskResult> {
  const trimmed = input.content.trim();
  if (!trimmed) return { ok: false, error: "Message is required." };
  if (trimmed.length > GOAT_TASK_CONTINUATION_MAX_CHARS) {
    return {
      ok: false,
      error: `Message is too long. Keep it under ${GOAT_TASK_CONTINUATION_MAX_CHARS.toLocaleString()} characters.`,
    };
  }

  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const messageId = `goat_task_msg_${randomUUID()}`;
  const task = await loadContinuationTaskForUser({
    db,
    taskDisplayIdOrId: input.taskDisplayIdOrId,
    userWorkosId: input.userWorkosId,
  });
  if (!task) return { ok: false, error: "Task not found." };
  if (task.status !== "succeeded" && task.status !== "failed") {
    return { ok: false, error: "Only completed or failed tasks can be continued." };
  }
  if (task.leaseId || task.leaseOwner || task.leaseExpiresAt) {
    return { ok: false, error: "This task is still running. Try again shortly." };
  }

  const messages = await loadContinuationMessages(db, task.id);
  const events = await loadContinuationEvents(db, task.id, RECENT_EVENT_LIMIT);
  const modelContent = buildGoatTaskContinuationPrompt({
    task,
    messages,
    events,
    latestInstruction: trimmed,
  });
  const statusEventPayload = {
    status: "queued",
    stage: "queued",
    actor: input.actor,
    continuedFromStatus: task.status,
  };

  const queued = rowsFromExecute<{ taskId: string; displayId: string; messageId: string }>(
    await db.execute(sql`
      WITH eligible_task AS (
        SELECT
          task.id,
          task.display_id,
          task.user_workos_id,
          task.status
        FROM goat.tasks AS task
        WHERE task.id = ${task.id}
          AND task.user_workos_id = ${input.userWorkosId}
          AND task.archived_at IS NULL
          AND task.status IN ('succeeded', 'failed')
          AND task.lease_id IS NULL
          AND task.lease_owner IS NULL
          AND task.lease_expires_at IS NULL
        FOR UPDATE
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
          ${messageId},
          task.id,
          task.user_workos_id,
          'user',
          'completed',
          ${trimmed},
          ${JSON.stringify({ role: "user", content: modelContent })}::jsonb,
          ${now},
          ${now},
          ${now}
        FROM eligible_task AS task
        RETURNING id, task_id
      ),
      updated_task AS (
        UPDATE goat.tasks AS task
        SET status = 'queued',
            stage = 'queued',
            result = NULL,
            error = NULL,
            lease_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_run_at = ${now},
            updated_at = ${now}
        FROM eligible_task AS eligible
        WHERE task.id = eligible.id
          AND EXISTS (SELECT 1 FROM inserted_user_message)
        RETURNING task.id, task.display_id
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
          ${messageId},
          'task.status',
          ${JSON.stringify(statusEventPayload)}::jsonb,
          ${now}
        FROM eligible_task AS task
        WHERE EXISTS (SELECT 1 FROM updated_task)
        RETURNING id
      )
      SELECT
        updated_task.id AS "taskId",
        updated_task.display_id AS "displayId",
        inserted_user_message.id AS "messageId"
      FROM updated_task
      JOIN inserted_user_message ON inserted_user_message.task_id = updated_task.id
      WHERE EXISTS (SELECT 1 FROM inserted_event)
    `),
  )[0];

  if (!queued) {
    return { ok: false, error: "This task is still running. Try again shortly." };
  }

  try {
    await input.wakeRunner?.(queued.taskId);
  } catch (error) {
    console.warn("Goat runner dispatch failed; the continued task remains queued for polling.", {
      event: "goat.runner_task_continued_dispatch_failed",
      task_id: queued.taskId,
      error,
    });
  }

  return { ok: true, ...queued };
}

export function buildGoatTaskContinuationPrompt(input: {
  task: Pick<ContinueTaskRow, "displayId" | "name" | "prompt" | "status" | "result" | "error">;
  messages: GoatTaskContinuationMessageRow[];
  events: GoatTaskContinuationEventRow[];
  latestInstruction: string;
}) {
  const transcript = input.messages
    .slice(-RECENT_TRANSCRIPT_LIMIT)
    .map((message) => formatMessageForContext(message))
    .join("\n");
  const events = input.events
    .slice(-RECENT_EVENT_LIMIT)
    .map((event) => formatEventForContext(event))
    .join("\n");

  return [
    "Continue this Goat task from its prior state using the latest human instruction.",
    "Do not repeat completed work or duplicate side effects unless the latest instruction explicitly asks for that.",
    "Use the prior result, transcript, and events as context. Produce the next assistant answer for the latest instruction.",
    "",
    `<task id="${escapeXml(input.task.displayId)}" name="${escapeXml(input.task.name)}">`,
    `<original_prompt>${escapeXml(truncateText(input.task.prompt, RESULT_CONTEXT_MAX_CHARS))}</original_prompt>`,
    `<previous_status>${escapeXml(input.task.status)}</previous_status>`,
    input.task.result
      ? `<previous_result>${escapeXml(truncateText(input.task.result, RESULT_CONTEXT_MAX_CHARS))}</previous_result>`
      : "<previous_result />",
    input.task.error
      ? `<previous_error>${escapeXml(truncateText(input.task.error, ERROR_CONTEXT_MAX_CHARS))}</previous_error>`
      : "<previous_error />",
    transcript
      ? `<recent_transcript>\n${transcript}\n</recent_transcript>`
      : "<recent_transcript />",
    events ? `<recent_events>\n${events}\n</recent_events>` : "<recent_events />",
    `<latest_human_instruction>${escapeXml(input.latestInstruction)}</latest_human_instruction>`,
    "</task>",
  ].join("\n");
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

async function loadContinuationTaskForUser(input: {
  db: Db;
  taskDisplayIdOrId: string;
  userWorkosId: string;
}) {
  const normalizedDisplayId = input.taskDisplayIdOrId.trim().toUpperCase();
  return rowsFromExecute<ContinueTaskRow>(
    await input.db.execute(sql`
      SELECT
        task.id,
        task.display_id AS "displayId",
        task.name,
        task.user_workos_id AS "userWorkosId",
        task.prompt,
        task.model,
        task.status,
        task.stage,
        task.result,
        task.error,
        task.harness_spec AS "harnessSpec",
        task.debug_trace AS "debugTrace",
        task.codex_engine_session_id AS "codexEngineSessionId",
        task.sandbox_id AS "sandboxId",
        task.attempts,
        task.next_run_at AS "nextRunAt",
        task.lease_id AS "leaseId",
        task.lease_owner AS "leaseOwner",
        task.lease_expires_at AS "leaseExpiresAt",
        task.archived_at AS "archivedAt",
        task.created_at AS "createdAt",
        task.updated_at AS "updatedAt"
      FROM goat.tasks AS task
      WHERE (task.id = ${input.taskDisplayIdOrId} OR task.display_id = ${normalizedDisplayId})
        AND task.user_workos_id = ${input.userWorkosId}
        AND task.archived_at IS NULL
      LIMIT 1
    `),
  )[0];
}

async function loadContinuationMessages(db: Db, taskId: string) {
  return rowsFromExecute<GoatTaskContinuationMessageRow>(
    await db.execute(sql`
      SELECT
        id,
        role,
        status,
        content,
        model_message AS "modelMessage",
        tool_name AS "toolName",
        tool_call_id AS "toolCallId",
        response_to_message_id AS "responseToMessageId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        completed_at AS "completedAt"
      FROM goat.task_messages
      WHERE task_id = ${taskId}
      ORDER BY created_at ASC, id ASC
    `),
  );
}

async function loadContinuationEvents(db: Db, taskId: string, limit?: number) {
  const rows = rowsFromExecute<GoatTaskContinuationEventRow>(
    await db.execute(sql`
      SELECT
        id,
        message_id AS "messageId",
        type,
        payload,
        created_at AS "createdAt"
      FROM goat.task_events
      WHERE task_id = ${taskId}
      ORDER BY id DESC
      ${limit ? sql`LIMIT ${limit}` : sql``}
    `),
  );
  return rows.toReversed();
}

function formatMessageForContext(message: GoatTaskContinuationMessageRow) {
  const tool = message.toolName ? ` tool="${message.toolName}"` : "";
  const responseTo = message.responseToMessageId
    ? ` response_to="${message.responseToMessageId}"`
    : "";
  return [
    `<message id="${escapeXml(message.id)}" role="${message.role}" status="${message.status}"${tool}${responseTo}>`,
    escapeXml(truncateText(message.content, MESSAGE_CONTEXT_MAX_CHARS)),
    "</message>",
  ].join("");
}

function formatEventForContext(event: GoatTaskContinuationEventRow) {
  return [
    `<event type="${event.type}"${event.messageId ? ` message_id="${escapeXml(event.messageId)}"` : ""}>`,
    escapeXml(truncateText(JSON.stringify(event.payload), EVENT_CONTEXT_MAX_CHARS)),
    "</event>",
  ].join("");
}

function truncateText(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n[truncated ${value.length - maxChars} chars]`;
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
