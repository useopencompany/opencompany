import { randomUUID } from "node:crypto";
import { goatTaskRunSessionId } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { goatTasks } from "@opencompany/db/goat-schema";
import { and, eq, or, sql } from "drizzle-orm";
import { createGoatCodexChatMessage } from "@/lib/codex-chat";
import { triggerGoatTaskRun } from "@/lib/task-runner";

export type GoatTaskSteeringResult =
  | { ok: true; taskId: string; messageId: string }
  | { ok: false; status: 404 | 409; error: string };

// Inserts a user message into a task's run session and wakes the runner. The
// runner's drain loop picks the message up mid-run (or a reclaim picks it up
// after a crash). The inserted row must NOT set chat_messages.task_id — that
// column marks the origin chat a task was spawned from, and the completion
// notification CTEs join on it.
export async function sendGoatTaskSteeringMessage(input: {
  userWorkosId: string;
  taskId: string;
  prompt: string;
}): Promise<GoatTaskSteeringResult> {
  const normalized = input.taskId.trim();
  const [task] = await getDb()
    .select({
      id: goatTasks.id,
      status: goatTasks.status,
      engine: goatTasks.engine,
    })
    .from(goatTasks)
    .where(
      and(
        eq(goatTasks.userWorkosId, input.userWorkosId),
        or(eq(goatTasks.id, normalized), eq(goatTasks.displayId, normalized.toUpperCase())),
      ),
    )
    .limit(1);
  if (!task) return { ok: false, status: 404, error: "Task not found." };
  if (task.status !== "queued" && task.status !== "running") {
    return { ok: false, status: 409, error: "This task is no longer running." };
  }
  if (task.engine === "codex") {
    // Codex tasks are driven by the codex chat worker: steering enqueues
    // another codex turn on the task's run session (with its own assistant
    // placeholder) instead of inserting a bare user message. The enqueue path
    // wakes the codex chat worker itself.
    const result = await createGoatCodexChatMessage({
      userWorkosId: input.userWorkosId,
      sessionId: goatTaskRunSessionId(task.id),
      prompt: input.prompt,
    });
    if (!result.ok) {
      return {
        ok: false,
        status: result.status === 404 ? 404 : 409,
        error: result.error,
      };
    }
    return { ok: true, taskId: task.id, messageId: result.userMessageId };
  }

  const sessionId = goatTaskRunSessionId(task.id);
  const messageId = `goat_chat_msg_${randomUUID()}`;
  const now = new Date();
  const result = await getDb().execute(sql`
    WITH run_session AS (
      SELECT session.id
      FROM goat.chat_sessions AS session
      WHERE session.id = ${sessionId}
        AND session.user_workos_id = ${input.userWorkosId}
        AND session.task_id = ${task.id}
    ),
    inserted AS (
      INSERT INTO goat.chat_messages (id, session_id, role, content, created_at, updated_at)
      SELECT ${messageId}, run_session.id, 'user', ${input.prompt}, ${now}, ${now}
      FROM run_session
      RETURNING id
    ),
    touched AS (
      UPDATE goat.chat_sessions AS session
      SET updated_at = ${now}
      FROM inserted
      WHERE session.id = ${sessionId}
      RETURNING session.id
    )
    SELECT id FROM inserted
  `);
  const inserted = rowsFromExecute<{ id: string }>(result)[0];
  if (!inserted) {
    return { ok: false, status: 409, error: "This task does not have a run session." };
  }

  try {
    await triggerGoatTaskRun(task.id, {
      task_id: task.id,
      event: "goat.runner_task_steering_dispatch",
    });
  } catch (error) {
    console.warn("Goat runner steering wake failed; the message waits for polling.", {
      event: "goat.runner_task_steering_dispatch_failed",
      task_id: task.id,
      error,
    });
  }

  return { ok: true, taskId: task.id, messageId: inserted.id };
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
