import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { rowsFromExecute } from "./sql-exec";

// Settles the goat.tasks row behind a codex run session once its driving codex
// chat turn reaches a terminal state. Codex tasks are executed by the codex
// chat worker (never the task worker), so there is no task lease to guard on:
// the update is keyed on chat_sessions.task_id and gated on the task still
// being queued/running. A steering turn that is still queued or running keeps
// the task open; the last turn's settle closes it. The whole statement no-ops
// for ordinary codex chats (task_id IS NULL on the session).
export async function settleTaskForCodexSession(input: {
  chatSessionId: string;
  userWorkosId: string;
  turnId: string;
  assistantMessageId: string;
  outcome: "succeeded" | "failed";
  error?: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const succeeded = input.outcome === "succeeded";
  const error = (input.error ?? "Codex task failed.").trim() || "Codex task failed.";
  const commentId = `goat_task_comment_${input.turnId}_${succeeded ? "result" : "failed"}`;
  const taskUpdateSql = succeeded
    ? sql`status = 'succeeded',
          result = final_message.content,
          error = NULL,
          updated_at = ${now}`
    : sql`status = 'failed',
          error = ${error},
          updated_at = ${now}`;
  const notificationContent = succeeded
    ? sql`
        'Task [' || task.display_id || '](/tasks/' || task.display_id || ') finished.' ||
        CASE WHEN btrim(COALESCE(task.result, '')) = '' THEN '' ELSE E'\n\n' || btrim(task.result) END
      `
    : sql`
        'Task [' || task.display_id || '](/tasks/' || task.display_id || ') failed.' ||
        E'\n\n' || ${error}
      `;

  const result = await getDb().execute(sql`
    WITH run_session AS (
      SELECT session.id, session.task_id
      FROM goat.chat_sessions AS session
      WHERE session.id = ${input.chatSessionId}
        AND session.user_workos_id = ${input.userWorkosId}
        AND session.task_id IS NOT NULL
    ),
    final_message AS (
      SELECT COALESCE(
        (
          SELECT message.content
          FROM goat.chat_messages AS message
          WHERE message.id = ${input.assistantMessageId}
            AND message.role = 'assistant'
        ),
        ''
      ) AS content
    ),
    settled_task AS (
      UPDATE goat.tasks AS task
      SET ${taskUpdateSql}
      FROM run_session, final_message
      WHERE task.id = run_session.task_id
        AND task.user_workos_id = ${input.userWorkosId}
        AND task.status IN ('queued', 'running')
        AND NOT EXISTS (
          SELECT 1
          FROM goat.codex_chat_turns AS pending
          WHERE pending.chat_session_id = run_session.id
            AND pending.status IN ('queued', 'running')
        )
      RETURNING task.id, task.display_id, task.name, task.user_workos_id, task.result
    ),
    settle_comment AS (
      INSERT INTO goat.task_comments (id, task_id, user_workos_id, author, kind, content, metadata, created_at, updated_at)
      SELECT
        ${commentId},
        task.id,
        task.user_workos_id,
        'agent',
        ${succeeded ? "result" : "status"},
        ${succeeded ? sql`COALESCE(task.result, '')` : sql`''`},
        ${succeeded ? "{}" : JSON.stringify({ status: "failed", error })}::jsonb,
        ${now},
        ${now}
      FROM settled_task AS task
      ON CONFLICT (id) DO NOTHING
    ),
    origin_chat AS (
      SELECT message.session_id, task.id AS task_id, task.display_id, task.name
      FROM goat.chat_messages AS message
      INNER JOIN goat.chat_sessions AS session ON session.id = message.session_id
      INNER JOIN settled_task AS task ON task.id = message.task_id
      WHERE session.closed_at IS NULL
        AND session.task_id IS NULL
      ORDER BY message.created_at ASC
      LIMIT 1
    ),
    inserted_notification AS (
      INSERT INTO goat.chat_messages (id, session_id, role, content, debug_trace, created_at, updated_at)
      SELECT
        ${`goat_chat_msg_${randomUUID()}`},
        origin.session_id,
        'assistant',
        ${notificationContent},
        jsonb_build_object(
          'schemaVersion', 'goat.chat.debug.v1',
          'taskNotification', jsonb_build_object(
            'taskId', origin.task_id,
            'taskDisplayId', origin.display_id,
            'taskName', origin.name,
            'status', ${succeeded ? "succeeded" : "failed"}::text
          )${succeeded ? sql`` : sql`, 'error', ${error}::text`}
        ),
        ${now},
        ${now}
      FROM origin_chat AS origin
      CROSS JOIN settled_task AS task
      WHERE NOT EXISTS (
        SELECT 1
        FROM goat.chat_messages AS existing
        WHERE existing.session_id = origin.session_id
          AND existing.debug_trace->'taskNotification'->>'taskId' = task.id
      )
      RETURNING session_id
    ),
    touched_chat AS (
      UPDATE goat.chat_sessions AS session
      SET updated_at = ${now}
      FROM inserted_notification AS notification
      WHERE session.id = notification.session_id
      RETURNING session.id
    )
    SELECT id FROM settled_task
  `);
  return rowsFromExecute<{ id: string }>(result).length > 0;
}
