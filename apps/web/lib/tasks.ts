"use server";

import { randomUUID } from "node:crypto";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import {
  type Actor,
  CHAT_WRITE_PERMISSION,
  ChatApplicationService,
  CoreError,
  type TaskSource,
} from "@opencompany/core";
import { PostgresChatRepository } from "@opencompany/db/chat-repository";
import { getDb } from "@opencompany/db/client";
import type {
  GoatChatMessageAttachment,
  GoatHarnessEngine,
  GoatHarnessSpec,
} from "@opencompany/db/goat-schema";
import {
  goatChatSessions,
  goatTaskEvents,
  goatTaskMessages,
  goatTaskModelUsage,
  goatTaskSandboxUsage,
  goatTasks,
  goatTaskToolUsage,
} from "@opencompany/db/goat-schema";
import { createGoatTaskForActor } from "@opencompany/goat-agent/application/task-creation";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { after } from "next/server";
import { currentGoatUser } from "@/lib/auth";
import { goatHomeActivityCutoff } from "@/lib/home-activity";
import {
  GoatSkillMentionError,
  readGoatSkillMentionRefs,
  resolveGoatSkillMentions,
} from "@/lib/skills";
import { triggerGoatCodexChatWake } from "@/lib/task-runner";
import { GOAT_TASK_PROMPT_MAX_LENGTH } from "@/lib/task-validation";

export type ArchiveTaskResult = {
  ok: boolean;
  error: string | null;
};

export type CancelTaskResult = {
  ok: boolean;
  error: string | null;
};

export type ContinueTaskResult = {
  ok: boolean;
  error: string | null;
  messageId: string | null;
};

export async function listCurrentUserGoatTasks() {
  const { user, workspace } = await currentGoatUser();
  return getDb()
    .select()
    .from(goatTasks)
    .where(
      and(
        goatTaskVisibleInWorkspace({
          userWorkosId: user.workosUserId,
          workspaceId: workspace.id,
        }),
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
  const { user, workspace } = await currentGoatUser();
  const normalizedTaskId = taskId.trim().toUpperCase();
  const [task] = await getDb()
    .select()
    .from(goatTasks)
    .where(
      and(
        goatTaskVisibleInWorkspace({
          userWorkosId: user.workosUserId,
          workspaceId: workspace.id,
        }),
        or(eq(goatTasks.id, taskId), eq(goatTasks.displayId, normalizedTaskId)),
      ),
    )
    .limit(1);

  return task ?? null;
}

export async function getCurrentUserGoatTaskSummary(taskId: string) {
  const task = await getCurrentUserGoatTask(taskId);
  if (!task) return null;

  const [aggregate] = rowsFromExecute<{
    runStartedAt: Date | string | null;
    runCompletedAt: Date | string | null;
    runDurationMs: number | string | null;
    usageRowCount: number | string;
    totalCostUsdMicros: number | string;
  }>(
    await getDb().execute(
      task.sessionId
        ? sql`
            WITH task_chat_sessions AS (
              SELECT ${task.sessionId}::text AS session_id
              UNION
              SELECT DISTINCT message.session_id
              FROM goat.chat_messages AS message
              WHERE message.task_id = ${task.id}
            )
            SELECT
              NULL AS "runStartedAt",
              NULL AS "runCompletedAt",
              (
                SELECT SUM(
                  CASE
                    WHEN jsonb_typeof(message.debug_trace->'durationMs') = 'number'
                      THEN (message.debug_trace->>'durationMs')::bigint
                    ELSE NULL
                  END
                )
                FROM goat.chat_messages AS message
                WHERE message.session_id IN (SELECT session_id FROM task_chat_sessions)
                  AND message.role = 'assistant'
              ) AS "runDurationMs",
              (
                SELECT COUNT(*)
                FROM goat.credit_ledger AS ledger
                WHERE ledger.chat_session_id IN (SELECT session_id FROM task_chat_sessions)
                  AND ledger.user_workos_id = ${task.userWorkosId}
                  AND ledger.amount_usd_micros < 0
              ) AS "usageRowCount",
              (
                SELECT COALESCE(SUM(-ledger.amount_usd_micros), 0)
                FROM goat.credit_ledger AS ledger
                WHERE ledger.chat_session_id IN (SELECT session_id FROM task_chat_sessions)
                  AND ledger.user_workos_id = ${task.userWorkosId}
                  AND ledger.amount_usd_micros < 0
              ) AS "totalCostUsdMicros"
          `
        : sql`
            SELECT
              (
                SELECT MIN(${goatTaskMessages.createdAt})
                FROM ${goatTaskMessages}
                WHERE ${goatTaskMessages.taskId} = ${task.id}
                  AND ${goatTaskMessages.userWorkosId} = ${task.userWorkosId}
                  AND ${goatTaskMessages.role} <> 'user'
              ) AS "runStartedAt",
              (
                SELECT MAX(${goatTaskMessages.completedAt})
                FROM ${goatTaskMessages}
                WHERE ${goatTaskMessages.taskId} = ${task.id}
                  AND ${goatTaskMessages.userWorkosId} = ${task.userWorkosId}
              ) AS "runCompletedAt",
              NULL AS "runDurationMs",
              (
                SELECT COUNT(*) FROM ${goatTaskModelUsage}
                WHERE ${goatTaskModelUsage.taskId} = ${task.id}
                  AND ${goatTaskModelUsage.userWorkosId} = ${task.userWorkosId}
              ) + (
                SELECT COUNT(*) FROM ${goatTaskToolUsage}
                WHERE ${goatTaskToolUsage.taskId} = ${task.id}
                  AND ${goatTaskToolUsage.userWorkosId} = ${task.userWorkosId}
              ) + (
                SELECT COUNT(*) FROM ${goatTaskSandboxUsage}
                WHERE ${goatTaskSandboxUsage.taskId} = ${task.id}
                  AND ${goatTaskSandboxUsage.userWorkosId} = ${task.userWorkosId}
              ) AS "usageRowCount",
              (
                SELECT COALESCE(SUM(${goatTaskModelUsage.totalCostUsdMicros}), 0)
                FROM ${goatTaskModelUsage}
                WHERE ${goatTaskModelUsage.taskId} = ${task.id}
                  AND ${goatTaskModelUsage.userWorkosId} = ${task.userWorkosId}
              ) + (
                SELECT COALESCE(SUM(${goatTaskToolUsage.totalCostUsdMicros}), 0)
                FROM ${goatTaskToolUsage}
                WHERE ${goatTaskToolUsage.taskId} = ${task.id}
                  AND ${goatTaskToolUsage.userWorkosId} = ${task.userWorkosId}
              ) + (
                SELECT COALESCE(SUM(${goatTaskSandboxUsage.totalCostUsdMicros}), 0)
                FROM ${goatTaskSandboxUsage}
                WHERE ${goatTaskSandboxUsage.taskId} = ${task.id}
                  AND ${goatTaskSandboxUsage.userWorkosId} = ${task.userWorkosId}
              ) AS "totalCostUsdMicros"
          `,
    ),
  );

  if (!aggregate) {
    throw new Error("Could not load Goat task summary.");
  }

  const terminal =
    task.status === "succeeded" || task.status === "failed" || task.status === "canceled";
  const startedAt = aggregate.runStartedAt
    ? new Date(aggregate.runStartedAt).getTime()
    : Number.NaN;
  const completedAt = aggregate.runCompletedAt
    ? new Date(aggregate.runCompletedAt).getTime()
    : Number.NaN;
  const recordedDurationMs =
    aggregate.runDurationMs === null ? Number.NaN : Number(aggregate.runDurationMs);
  const durationMs =
    terminal && Number.isFinite(recordedDurationMs)
      ? Math.max(0, recordedDurationMs)
      : terminal && Number.isFinite(startedAt) && Number.isFinite(completedAt)
        ? Math.max(0, completedAt - startedAt)
        : null;
  const usageRowCount = Number(aggregate.usageRowCount);
  const totalCostUsdMicros = Number(aggregate.totalCostUsdMicros);

  return {
    cost: {
      hasRecordedCosts: Number.isFinite(usageRowCount) && usageRowCount > 0,
      totalCostUsdMicros: Number.isFinite(totalCostUsdMicros) ? Math.max(0, totalCostUsdMicros) : 0,
    },
    durationMs,
  };
}

export async function getCurrentUserGoatTaskRun(taskId: string) {
  const task = await getCurrentUserGoatTask(taskId);

  if (!task) return null;

  const [messages, events, modelUsage, toolUsage, sandboxUsage] = await Promise.all([
    getDb()
      .select()
      .from(goatTaskMessages)
      .where(
        and(
          eq(goatTaskMessages.userWorkosId, task.userWorkosId),
          eq(goatTaskMessages.taskId, task.id),
        ),
      )
      .orderBy(asc(goatTaskMessages.createdAt)),
    getDb()
      .select()
      .from(goatTaskEvents)
      .where(
        and(eq(goatTaskEvents.userWorkosId, task.userWorkosId), eq(goatTaskEvents.taskId, task.id)),
      )
      .orderBy(asc(goatTaskEvents.id)),
    getDb()
      .select()
      .from(goatTaskModelUsage)
      .where(
        and(
          eq(goatTaskModelUsage.userWorkosId, task.userWorkosId),
          eq(goatTaskModelUsage.taskId, task.id),
        ),
      )
      .orderBy(asc(goatTaskModelUsage.createdAt), asc(goatTaskModelUsage.id)),
    getDb()
      .select()
      .from(goatTaskToolUsage)
      .where(
        and(
          eq(goatTaskToolUsage.userWorkosId, task.userWorkosId),
          eq(goatTaskToolUsage.taskId, task.id),
        ),
      )
      .orderBy(asc(goatTaskToolUsage.createdAt), asc(goatTaskToolUsage.id)),
    getDb()
      .select()
      .from(goatTaskSandboxUsage)
      .where(
        and(
          eq(goatTaskSandboxUsage.userWorkosId, task.userWorkosId),
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

  const { user, workspace } = await currentGoatUser();
  const taskVisibility = goatTaskVisibleInWorkspace({
    userWorkosId: user.workosUserId,
    workspaceId: workspace.id,
  });
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
        taskVisibility,
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

  const { user, workspace } = await currentGoatUser();
  const [sessionTask] = await getDb()
    .select({
      sessionId: goatTasks.sessionId,
      userWorkosId: goatTasks.userWorkosId,
      runId: sql<string | null>`(
        SELECT turn.id
        FROM goat.codex_chat_turns AS turn
        WHERE turn.chat_session_id = ${goatTasks.sessionId}
          AND turn.status IN ('queued', 'running', 'paused')
        ORDER BY turn.created_at DESC, turn.id DESC
        LIMIT 1
      )`,
    })
    .from(goatTasks)
    .where(
      and(
        eq(goatTasks.id, taskId),
        goatTaskVisibleInWorkspace({
          userWorkosId: user.workosUserId,
          workspaceId: workspace.id,
        }),
      ),
    )
    .limit(1);
  if (sessionTask?.sessionId && sessionTask.runId) {
    try {
      await canonicalChatService().cancelRun(
        canonicalChatActor(user.workosUserId, workspace.id),
        sessionTask.runId,
      );
      return { ok: true, error: null };
    } catch (error) {
      if (error instanceof CoreError && error.code === "not_found") {
        return { ok: false, error: "Could not stop task." };
      }
      throw error;
    }
  }

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
        AND task.user_workos_id = ${sessionTask?.userWorkosId ?? user.workosUserId}
        AND (
          task.workspace_id = ${workspace.id}
          OR (task.workspace_id IS NULL AND task.user_workos_id = ${user.workosUserId})
        )
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

// Tasks are durable conversations. A reply appends a completed user turn and
// atomically moves a terminal task back to the queue; the runner then answers
// with the same instructions and prior conversation context.
export async function continueGoatTaskAction(
  taskId: string,
  prompt: string,
  clientMessageId?: string,
  mentions?: unknown,
): Promise<ContinueTaskResult> {
  const normalizedTaskId = taskId.trim();
  const content = prompt.trim();
  if (!normalizedTaskId || !content) {
    return { ok: false, error: "Write a message to continue this task.", messageId: null };
  }
  if (content.length > GOAT_TASK_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      error: `Messages can be at most ${GOAT_TASK_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
      messageId: null,
    };
  }

  const { user, workspace } = await currentGoatUser();
  const parsedSkillMentions = readGoatSkillMentionRefs(mentions);
  if (!parsedSkillMentions.ok) {
    return { ok: false, error: parsedSkillMentions.error, messageId: null };
  }
  let resolvedSkills: Awaited<ReturnType<typeof resolveGoatSkillMentions>> = [];
  if (parsedSkillMentions.mentions.length > 0) {
    try {
      resolvedSkills = await resolveGoatSkillMentions({
        workspaceId: workspace.id,
        mentions: parsedSkillMentions.mentions,
      });
    } catch (error) {
      if (error instanceof GoatSkillMentionError) {
        return { ok: false, error: error.message, messageId: null };
      }
      throw error;
    }
  }
  const [task] = await getDb()
    .select({
      sessionId: goatTasks.sessionId,
      userWorkosId: goatTasks.userWorkosId,
      engine: goatChatSessions.engine,
      model: goatChatSessions.model,
    })
    .from(goatTasks)
    .leftJoin(goatChatSessions, eq(goatChatSessions.id, goatTasks.sessionId))
    .where(
      and(
        eq(goatTasks.id, normalizedTaskId),
        goatTaskVisibleInWorkspace({
          userWorkosId: user.workosUserId,
          workspaceId: workspace.id,
        }),
      ),
    )
    .limit(1);
  if (task?.sessionId && task.engine && task.model) {
    let continued;
    try {
      continued = await canonicalChatService().createMessage(
        canonicalChatActor(user.workosUserId, workspace.id),
        {
          conversationId: task.sessionId,
          idempotencyKey: clientMessageId ?? `task:${normalizedTaskId}:message:${randomUUID()}`,
          ...(clientMessageId ? { clientMessageId } : {}),
          content,
          engine: task.engine,
          model: task.model,
          ...(resolvedSkills.length > 0
            ? {
                mentions: resolvedSkills.map((skill) => ({ kind: "skill" as const, id: skill.id })),
              }
            : {}),
        },
      );
    } catch (error) {
      if (!(error instanceof CoreError) || error.code !== "not_found") throw error;
      return {
        ok: false,
        error: "Wait for this task to finish before sending another message.",
        messageId: null,
      };
    }
    await triggerGoatCodexChatWake().catch((error) => {
      console.warn("Goat durable task wake failed; the turn remains queued for polling.", {
        event: "goat.durable_task_continued_wake_failed",
        task_id: normalizedTaskId,
        error,
      });
    });
    return { ok: true, error: null, messageId: continued.messageId };
  }

  // Tasks without a session predate durable session execution; the legacy runner drain
  // that executed them is gone, so they can only be read, not continued.
  return {
    ok: false,
    error:
      "This task predates durable task sessions and can no longer be continued. Start a new task instead.",
    messageId: null,
  };
}

export async function createGoatTaskForUser(input: {
  userWorkosId: string;
  workspaceId?: string | null;
  brainRef?: string | null;
  prompt: string;
  model: AgentModelId;
  name?: string;
  engine?: GoatHarnessEngine;
  harnessSpec?: GoatHarnessSpec;
  scheduleId?: string;
  scheduledFor?: Date;
  workflowId?: string;
  workflowBrainRef?: string;
  attachments?: GoatChatMessageAttachment[];
  attachmentTexts?: Record<string, string> | null;
  source?: TaskSource;
  idempotencyKey?: string;
}) {
  const { userWorkosId, ...command } = input;
  return createGoatTaskForActor(
    { ...command, actorId: userWorkosId },
    {
      wakeTaskWorker: triggerGoatCodexChatWake,
      defer: after,
    },
  );
}

function canonicalChatService() {
  return new ChatApplicationService(new PostgresChatRepository((query) => getDb().execute(query)));
}

function canonicalChatActor(userId: string, workspaceId: string): Actor {
  return {
    userId,
    workspaceId,
    role: "member",
    permissions: [CHAT_WRITE_PERMISSION],
    authenticationMethod: "session",
  };
}

function goatTaskVisibleInWorkspace(input: { userWorkosId: string; workspaceId: string }) {
  return or(
    eq(goatTasks.workspaceId, input.workspaceId),
    and(eq(goatTasks.userWorkosId, input.userWorkosId), isNull(goatTasks.workspaceId)),
  );
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
