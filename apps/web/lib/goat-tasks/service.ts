import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import type {
  GoatTaskDebugTrace,
  GoatTaskEventPayload,
  GoatTaskEventType,
  GoatTaskMessageRole,
  GoatTaskMessageStatus,
  GoatTaskToolName,
} from "@opencompany/db/goat-schema";
import { sql } from "drizzle-orm";
import { ensureWorkspaceRunAllowance, runAllowanceErrorMessage } from "@/lib/billing/run-allowance";

export const GOAT_TASK_CONTINUATION_MAX_CHARS = 8_000;

const RECENT_TRANSCRIPT_LIMIT = 16;
const RECENT_EVENT_LIMIT = 12;
const MESSAGE_CONTEXT_MAX_CHARS = 1_200;
const RESULT_CONTEXT_MAX_CHARS = 6_000;
const ERROR_CONTEXT_MAX_CHARS = 2_000;
const EVENT_CONTEXT_MAX_CHARS = 700;

type Db = ReturnType<typeof getDb>;
type DbExecutor = Pick<Db, "execute">;

type TaskRow = {
  id: string;
  displayId: string;
  name: string;
  userWorkosId: string;
  prompt: string;
  model: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  stage: string;
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

export type GoatTaskMessageRow = {
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

export type GoatTaskEventRow = {
  id: number;
  messageId: string | null;
  type: GoatTaskEventType;
  payload: GoatTaskEventPayload;
  createdAt: Date | string;
};

export type GoatTaskDetailPayload = {
  task: {
    id: string;
    displayId: string;
    name: string;
    prompt: string;
    model: string;
    status: TaskRow["status"];
    stage: string;
    result: string | null;
    error: string | null;
    codexEngineSessionId: string | null;
    sandboxId: string | null;
    attempts: number;
    createdAt: string;
    updatedAt: string;
  };
  messages: Array<{
    id: string;
    role: GoatTaskMessageRole;
    status: GoatTaskMessageStatus;
    content: string;
    toolName: GoatTaskToolName | null;
    toolCallId: string | null;
    responseToMessageId: string | null;
    createdAt: string;
    completedAt: string | null;
  }>;
  events: Array<{
    id: number;
    messageId: string | null;
    type: GoatTaskEventType;
    payload: GoatTaskEventPayload;
    createdAt: string;
  }>;
  artifacts: unknown[];
};

export type ContinueGoatTaskResult =
  | { ok: true; taskId: string; displayId: string; messageId: string }
  | { ok: false; error: string };

export async function loadGoatTaskDetailForUser(input: {
  taskDisplayIdOrId: string;
  authUserWorkosId: string;
  db?: Db;
}): Promise<GoatTaskDetailPayload | null> {
  const db = input.db ?? getDb();
  const task = await loadTaskForUser({
    db,
    taskDisplayIdOrId: input.taskDisplayIdOrId,
    authUserWorkosId: input.authUserWorkosId,
    lock: false,
  });
  if (!task) return null;

  const [messages, events] = await Promise.all([
    loadTaskMessages(db, task.id),
    loadTaskEvents(db, task.id),
  ]);

  return serializeTaskDetail(task, messages, events);
}

export async function continueGoatTaskForActor(input: {
  actor: "human";
  taskDisplayIdOrId: string;
  content: string;
  authUserWorkosId: string;
  appUserId: string;
  workspaceId: string;
  db?: Db;
  now?: Date;
  wakeRunner?: (taskId: string) => Promise<void>;
}): Promise<ContinueGoatTaskResult> {
  const trimmed = input.content.trim();
  if (!trimmed) return { ok: false, error: "Message is required." };
  if (trimmed.length > GOAT_TASK_CONTINUATION_MAX_CHARS) {
    return {
      ok: false,
      error: `Message is too long. Keep it under ${GOAT_TASK_CONTINUATION_MAX_CHARS.toLocaleString()} characters.`,
    };
  }

  const db = input.db ?? getDb();
  const allowance = await ensureWorkspaceRunAllowance({
    db,
    workspaceId: input.workspaceId,
    userId: input.appUserId,
  });
  if (!allowance.allowed) {
    return { ok: false, error: runAllowanceErrorMessage(allowance.reason, "continue") };
  }

  const now = input.now ?? new Date();
  const messageId = newGoatTaskMessageId();
  const queued = await db.transaction(async (tx) => {
    const task = await loadTaskForUser({
      db: tx,
      taskDisplayIdOrId: input.taskDisplayIdOrId,
      authUserWorkosId: input.authUserWorkosId,
      lock: true,
    });
    if (!task) return { ok: false as const, error: "Task not found." };
    if (task.status !== "succeeded" && task.status !== "failed") {
      return { ok: false as const, error: "Only completed or failed tasks can be continued." };
    }
    if (task.leaseId || task.leaseOwner || task.leaseExpiresAt) {
      return { ok: false as const, error: "This task is still running. Try again shortly." };
    }

    const [messages, events] = await Promise.all([
      loadTaskMessages(tx, task.id),
      loadTaskEvents(tx, task.id, RECENT_EVENT_LIMIT),
    ]);
    const modelContent = buildGoatTaskContinuationPrompt({
      task,
      messages,
      events,
      latestInstruction: trimmed,
    });

    await tx.execute(sql`
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
      VALUES (
        ${messageId},
        ${task.id},
        ${task.userWorkosId},
        'user',
        'completed',
        ${trimmed},
        ${JSON.stringify({ role: "user", content: modelContent })}::jsonb,
        ${now},
        ${now},
        ${now}
      )
    `);

    const updated = rowsFromExecute<{ id: string }>(
      await tx.execute(sql`
        UPDATE goat.tasks
        SET status = 'queued',
            stage = 'queued',
            result = NULL,
            error = NULL,
            lease_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            next_run_at = ${now},
            updated_at = ${now}
        WHERE id = ${task.id}
          AND status IN ('succeeded', 'failed')
          AND lease_id IS NULL
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
        RETURNING id
      `),
    )[0];
    if (!updated) {
      return { ok: false as const, error: "This task is still running. Try again shortly." };
    }

    return {
      ok: true as const,
      taskId: task.id,
      displayId: task.displayId,
      messageId,
    };
  });

  if (!queued.ok) return queued;

  await input.wakeRunner?.(queued.taskId).catch(() => undefined);
  return queued;
}

export function buildGoatTaskContinuationPrompt(input: {
  task: Pick<TaskRow, "displayId" | "name" | "prompt" | "status" | "result" | "error">;
  messages: GoatTaskMessageRow[];
  events: GoatTaskEventRow[];
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

async function loadTaskForUser(input: {
  db: DbExecutor;
  taskDisplayIdOrId: string;
  authUserWorkosId: string;
  lock: boolean;
}) {
  const lockClause = input.lock ? sql`FOR UPDATE` : sql``;
  return rowsFromExecute<TaskRow>(
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
      WHERE (task.id = ${input.taskDisplayIdOrId} OR task.display_id = ${input.taskDisplayIdOrId})
        AND task.user_workos_id = ${input.authUserWorkosId}
        AND task.archived_at IS NULL
      LIMIT 1
      ${lockClause}
    `),
  )[0];
}

async function loadTaskMessages(db: DbExecutor, taskId: string) {
  return rowsFromExecute<GoatTaskMessageRow>(
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

async function loadTaskEvents(db: DbExecutor, taskId: string, limit?: number) {
  const rows = rowsFromExecute<GoatTaskEventRow>(
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

function serializeTaskDetail(
  task: TaskRow,
  messages: GoatTaskMessageRow[],
  events: GoatTaskEventRow[],
): GoatTaskDetailPayload {
  return {
    task: {
      id: task.id,
      displayId: task.displayId,
      name: task.name,
      prompt: task.prompt,
      model: task.model,
      status: task.status,
      stage: task.stage,
      result: task.result,
      error: task.error,
      codexEngineSessionId: task.codexEngineSessionId,
      sandboxId: task.sandboxId,
      attempts: task.attempts,
      createdAt: toIso(task.createdAt),
      updatedAt: toIso(task.updatedAt),
    },
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      status: message.status,
      content: message.content,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      responseToMessageId: message.responseToMessageId,
      createdAt: toIso(message.createdAt),
      completedAt: message.completedAt ? toIso(message.completedAt) : null,
    })),
    events: events.map((event) => ({
      id: event.id,
      messageId: event.messageId,
      type: event.type,
      payload: event.payload,
      createdAt: toIso(event.createdAt),
    })),
    artifacts: events.flatMap((event) =>
      event.type === "artifact.created" && "artifact" in event.payload
        ? [(event.payload as { artifact: unknown }).artifact]
        : [],
    ),
  };
}

function formatMessageForContext(message: GoatTaskMessageRow) {
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

function formatEventForContext(event: GoatTaskEventRow) {
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

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function newGoatTaskMessageId() {
  return `goat_task_msg_${randomUUID()}`;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
