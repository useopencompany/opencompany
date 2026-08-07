"use server";

import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { captureTaskSpawned } from "@opencompany/analytics/server";
import { getDb } from "@opencompany/db/client";
import type {
  ChatMessageAttachment,
  HarnessEngine,
  HarnessSpec,
  Task,
} from "@opencompany/db/schema";
import {
  taskEvents,
  taskMessages,
  taskModelUsage,
  taskSandboxUsage,
  tasks,
  taskToolUsage,
  users,
} from "@opencompany/db/schema";
import { createTaskSession, enqueueTaskSessionTurn } from "@opencompany/db/task-sessions";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { after } from "next/server";
import { currentUser } from "@/lib/auth";
import { TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { homeActivityCutoff } from "@/lib/home-activity";
import { getAvailableHarnessTools } from "@/lib/integrations/google-data";
import { readSkillMentionRefs, resolveSkillMentions, SkillMentionError } from "@/lib/skills";
import { normalizeTaskName } from "@/lib/task-display";
import { triggerCodexChatWake } from "@/lib/task-runner";
import { TASK_PROMPT_MAX_LENGTH } from "@/lib/task-validation";

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

export async function listCurrentUserTasks() {
  const { user, workspace } = await currentUser();
  return getDb()
    .select()
    .from(tasks)
    .where(
      and(
        taskVisibleInWorkspace({
          userWorkosId: user.workosUserId,
          workspaceId: workspace.id,
        }),
        isNull(tasks.archivedAt),
        or(
          inArray(tasks.status, ["queued", "running"]),
          gte(tasks.createdAt, homeActivityCutoff()),
        ),
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(50);
}

export async function getCurrentUserTask(taskId: string) {
  const { user, workspace } = await currentUser();
  const normalizedTaskId = taskId.trim().toUpperCase();
  const [task] = await getDb()
    .select()
    .from(tasks)
    .where(
      and(
        taskVisibleInWorkspace({
          userWorkosId: user.workosUserId,
          workspaceId: workspace.id,
        }),
        or(eq(tasks.id, taskId), eq(tasks.displayId, normalizedTaskId)),
      ),
    )
    .limit(1);

  return task ?? null;
}

export async function getCurrentUserTaskSummary(taskId: string) {
  const task = await getCurrentUserTask(taskId);
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
                SELECT MIN(${taskMessages.createdAt})
                FROM ${taskMessages}
                WHERE ${taskMessages.taskId} = ${task.id}
                  AND ${taskMessages.userWorkosId} = ${task.userWorkosId}
                  AND ${taskMessages.role} <> 'user'
              ) AS "runStartedAt",
              (
                SELECT MAX(${taskMessages.completedAt})
                FROM ${taskMessages}
                WHERE ${taskMessages.taskId} = ${task.id}
                  AND ${taskMessages.userWorkosId} = ${task.userWorkosId}
              ) AS "runCompletedAt",
              NULL AS "runDurationMs",
              (
                SELECT COUNT(*) FROM ${taskModelUsage}
                WHERE ${taskModelUsage.taskId} = ${task.id}
                  AND ${taskModelUsage.userWorkosId} = ${task.userWorkosId}
              ) + (
                SELECT COUNT(*) FROM ${taskToolUsage}
                WHERE ${taskToolUsage.taskId} = ${task.id}
                  AND ${taskToolUsage.userWorkosId} = ${task.userWorkosId}
              ) + (
                SELECT COUNT(*) FROM ${taskSandboxUsage}
                WHERE ${taskSandboxUsage.taskId} = ${task.id}
                  AND ${taskSandboxUsage.userWorkosId} = ${task.userWorkosId}
              ) AS "usageRowCount",
              (
                SELECT COALESCE(SUM(${taskModelUsage.totalCostUsdMicros}), 0)
                FROM ${taskModelUsage}
                WHERE ${taskModelUsage.taskId} = ${task.id}
                  AND ${taskModelUsage.userWorkosId} = ${task.userWorkosId}
              ) + (
                SELECT COALESCE(SUM(${taskToolUsage.totalCostUsdMicros}), 0)
                FROM ${taskToolUsage}
                WHERE ${taskToolUsage.taskId} = ${task.id}
                  AND ${taskToolUsage.userWorkosId} = ${task.userWorkosId}
              ) + (
                SELECT COALESCE(SUM(${taskSandboxUsage.totalCostUsdMicros}), 0)
                FROM ${taskSandboxUsage}
                WHERE ${taskSandboxUsage.taskId} = ${task.id}
                  AND ${taskSandboxUsage.userWorkosId} = ${task.userWorkosId}
              ) AS "totalCostUsdMicros"
          `,
    ),
  );

  if (!aggregate) {
    throw new Error("Could not load the task summary.");
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

export async function getCurrentUserTaskRun(taskId: string) {
  const task = await getCurrentUserTask(taskId);

  if (!task) return null;

  const [messages, events, modelUsage, toolUsage, sandboxUsage] = await Promise.all([
    getDb()
      .select()
      .from(taskMessages)
      .where(
        and(eq(taskMessages.userWorkosId, task.userWorkosId), eq(taskMessages.taskId, task.id)),
      )
      .orderBy(asc(taskMessages.createdAt)),
    getDb()
      .select()
      .from(taskEvents)
      .where(and(eq(taskEvents.userWorkosId, task.userWorkosId), eq(taskEvents.taskId, task.id)))
      .orderBy(asc(taskEvents.id)),
    getDb()
      .select()
      .from(taskModelUsage)
      .where(
        and(eq(taskModelUsage.userWorkosId, task.userWorkosId), eq(taskModelUsage.taskId, task.id)),
      )
      .orderBy(asc(taskModelUsage.createdAt), asc(taskModelUsage.id)),
    getDb()
      .select()
      .from(taskToolUsage)
      .where(
        and(eq(taskToolUsage.userWorkosId, task.userWorkosId), eq(taskToolUsage.taskId, task.id)),
      )
      .orderBy(asc(taskToolUsage.createdAt), asc(taskToolUsage.id)),
    getDb()
      .select()
      .from(taskSandboxUsage)
      .where(
        and(
          eq(taskSandboxUsage.userWorkosId, task.userWorkosId),
          eq(taskSandboxUsage.taskId, task.id),
        ),
      )
      .orderBy(asc(taskSandboxUsage.createdAt), asc(taskSandboxUsage.id)),
  ]);

  return { task, messages, events, modelUsage, toolUsage, sandboxUsage };
}

export async function archiveTaskAction(taskId: string): Promise<ArchiveTaskResult> {
  if (!taskId.trim()) {
    return { ok: false, error: "Could not archive task." };
  }

  const { user, workspace } = await currentUser();
  const taskVisibility = taskVisibleInWorkspace({
    userWorkosId: user.workosUserId,
    workspaceId: workspace.id,
  });
  const now = new Date();
  const [task] = await getDb()
    .update(tasks)
    .set({
      archivedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        taskVisibility,
        isNull(tasks.archivedAt),
        inArray(tasks.status, ["succeeded", "failed", "canceled"]),
      ),
    )
    .returning({ id: tasks.id });

  if (!task) {
    return { ok: false, error: "Could not archive task." };
  }

  return { ok: true, error: null };
}

export async function cancelTaskAction(taskId: string): Promise<CancelTaskResult> {
  if (!taskId.trim()) {
    return { ok: false, error: "Could not stop task." };
  }

  const { user, workspace } = await currentUser();
  const now = new Date();
  const [sessionTask] = await getDb()
    .select({ sessionId: tasks.sessionId, userWorkosId: tasks.userWorkosId })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, taskId),
        taskVisibleInWorkspace({
          userWorkosId: user.workosUserId,
          workspaceId: workspace.id,
        }),
      ),
    )
    .limit(1);
  if (sessionTask?.sessionId) {
    const result = await cancelSessionBackedTask({
      taskId,
      userWorkosId: sessionTask.userWorkosId,
      sessionId: sessionTask.sessionId,
      now,
    });
    return result ? { ok: true, error: null } : { ok: false, error: "Could not stop task." };
  }

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
export async function continueTaskAction(
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
  if (content.length > TASK_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      error: `Messages can be at most ${TASK_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
      messageId: null,
    };
  }

  const { user, workspace } = await currentUser();
  const parsedSkillMentions = readSkillMentionRefs(mentions);
  if (!parsedSkillMentions.ok) {
    return { ok: false, error: parsedSkillMentions.error, messageId: null };
  }
  let resolvedSkills: Awaited<ReturnType<typeof resolveSkillMentions>> = [];
  if (parsedSkillMentions.mentions.length > 0) {
    try {
      resolvedSkills = await resolveSkillMentions({
        workspaceId: workspace.id,
        mentions: parsedSkillMentions.mentions,
      });
    } catch (error) {
      if (error instanceof SkillMentionError) {
        return { ok: false, error: error.message, messageId: null };
      }
      throw error;
    }
  }
  const [task] = await getDb()
    .select({ sessionId: tasks.sessionId, userWorkosId: tasks.userWorkosId })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, normalizedTaskId),
        taskVisibleInWorkspace({
          userWorkosId: user.workosUserId,
          workspaceId: workspace.id,
        }),
      ),
    )
    .limit(1);
  if (task?.sessionId) {
    const continued = await enqueueTaskSessionTurn({
      taskId: normalizedTaskId,
      userWorkosId: task.userWorkosId,
      prompt: content,
      skills: resolvedSkills.map((skill) => ({
        ...skill,
        brainRef: workspace.id,
      })),
      clientMessageId,
    });
    if (!continued) {
      return {
        ok: false,
        error: "Wait for this task to finish before sending another message.",
        messageId: null,
      };
    }
    await triggerCodexChatWake().catch((error) => {
      console.warn("Durable task wake failed; the turn remains queued for polling.", {
        event: "goat.durable_task_continued_wake_failed",
        task_id: normalizedTaskId,
        error,
      });
    });
    return { ok: true, error: null, messageId: continued.id };
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

export async function createTaskForUser(input: {
  userWorkosId: string;
  workspaceId?: string | null;
  brainRef?: string | null;
  prompt: string;
  model: AgentModelId;
  name?: string;
  engine?: HarnessEngine;
  harnessSpec?: HarnessSpec;
  scheduleId?: string;
  scheduledFor?: Date;
  workflowId?: string;
  workflowBrainRef?: string;
  attachments?: ChatMessageAttachment[];
  attachmentTexts?: Record<string, string> | null;
}) {
  const initialTaskSpawningState = await loadTaskSpawningState(input.userWorkosId);
  if (initialTaskSpawningState === null) {
    throw new Error("Unable to create a task for an unknown user.");
  }
  if (!initialTaskSpawningState) {
    throw new Error(TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE);
  }

  const now = new Date();
  const name = normalizeTaskName(input.name, input.prompt);
  const tools = input.harnessSpec ? [] : await getAvailableHarnessTools(input.userWorkosId);
  const harnessSpec: HarnessSpec = input.harnessSpec ?? {
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
  const attachments = input.attachments ?? [];
  let task: Task;
  try {
    task = await createTaskSession({
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId ?? null,
      brainRef: input.brainRef ?? null,
      prompt: input.prompt,
      name,
      harnessSpec,
      scheduleId: input.scheduleId ?? null,
      scheduledFor: input.scheduledFor ?? null,
      workflowId: input.workflowId ?? null,
      workflowBrainRef: input.workflowBrainRef ?? null,
      attachments,
      attachmentTexts: input.attachmentTexts ?? null,
      now,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Unable to create task session.") {
      throw error;
    }
    const currentTaskSpawningState = await loadTaskSpawningState(input.userWorkosId);
    if (currentTaskSpawningState === null) {
      throw new Error("Unable to create a task for an unknown user.");
    }
    if (!currentTaskSpawningState) {
      throw new Error(TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE);
    }
    throw error;
  }
  captureTaskSpawnedAfterResponse(task, input.workspaceId ?? null);
  await triggerCodexChatWake().catch((error) => {
    console.warn("Durable task wake failed; the turn remains queued for polling.", {
      event: "goat.durable_task_created_wake_failed",
      task_id: task.id,
      error,
    });
  });
  return task;
}

function captureTaskSpawnedAfterResponse(task: Task, workspaceId: string | null | undefined) {
  after(
    captureTaskSpawned({
      userWorkosId: task.userWorkosId,
      workspaceId: workspaceId ?? task.harnessSpec.workflow?.workspaceId ?? null,
      taskId: task.id,
      displayId: task.displayId,
      engine: task.harnessSpec.engine,
      model: task.model,
      workflowId: task.workflowId,
      scheduleId: task.scheduleId,
      trigger: "manual",
    }).catch((error) => {
      console.warn("Task spawn analytics failed.", {
        event: "goat.task_spawned_analytics_failed",
        task_id: task.id,
        error,
      });
    }),
  );
}

async function cancelSessionBackedTask(input: {
  taskId: string;
  userWorkosId: string;
  sessionId: string;
  now: Date;
}) {
  const result = await getDb().execute(sql`
    WITH canceled_task AS (
      UPDATE goat.tasks AS task
      SET status = 'canceled',
          stage = 'canceled',
          error = 'Stopped by user.',
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${input.now}
      WHERE task.id = ${input.taskId}
        AND task.user_workos_id = ${input.userWorkosId}
        AND task.session_id = ${input.sessionId}
        AND task.status IN ('queued', 'running')
      RETURNING task.id
    ),
    requested_running AS (
      UPDATE goat.codex_chat_turns AS turn
      SET interrupt_requested_at = COALESCE(turn.interrupt_requested_at, ${input.now}),
          updated_at = ${input.now}
      WHERE turn.chat_session_id = ${input.sessionId}
        AND turn.user_workos_id = ${input.userWorkosId}
        AND turn.status = 'running'
        AND EXISTS (SELECT 1 FROM canceled_task)
      RETURNING turn.id
    ),
    canceled_queued AS (
      UPDATE goat.codex_chat_turns AS turn
      SET status = 'interrupted',
          completed_at = ${input.now},
          updated_at = ${input.now}
      WHERE turn.chat_session_id = ${input.sessionId}
        AND turn.user_workos_id = ${input.userWorkosId}
        AND turn.status = 'queued'
        AND EXISTS (SELECT 1 FROM canceled_task)
      RETURNING turn.assistant_message_id
    ),
    aborted_messages AS (
      UPDATE goat.chat_messages AS message
      SET debug_trace = COALESCE(
            message.debug_trace,
            jsonb_build_object('schemaVersion', 'goat.codex_chat.debug.v1')
          ) || jsonb_build_object('aborted', true),
          updated_at = ${input.now}
      FROM canceled_queued AS turn
      WHERE message.id = turn.assistant_message_id
      RETURNING message.id
    ),
    settled_runtime AS (
      UPDATE goat.codex_chat_sessions AS runtime
      SET status = 'interrupted',
          active_turn_id = NULL,
          error = NULL,
          updated_at = ${input.now}
      WHERE runtime.chat_session_id = ${input.sessionId}
        AND runtime.user_workos_id = ${input.userWorkosId}
        AND NOT EXISTS (
          SELECT 1
          FROM goat.codex_chat_turns AS running
          WHERE running.codex_chat_session_id = runtime.id
            AND running.status = 'running'
        )
        AND EXISTS (SELECT 1 FROM canceled_task)
      RETURNING runtime.id
    )
    SELECT task.id
    FROM canceled_task AS task
    CROSS JOIN (SELECT count(*) FROM requested_running) AS running_requests
    CROSS JOIN (SELECT count(*) FROM aborted_messages) AS message_updates
    CROSS JOIN (SELECT count(*) FROM settled_runtime) AS runtime_updates
  `);
  return rowsFromExecute<{ id: string }>(result).length > 0;
}

function taskVisibleInWorkspace(input: { userWorkosId: string; workspaceId: string }) {
  return or(
    eq(tasks.workspaceId, input.workspaceId),
    and(eq(tasks.userWorkosId, input.userWorkosId), isNull(tasks.workspaceId)),
  );
}

async function loadTaskSpawningState(userWorkosId: string): Promise<boolean | null> {
  const [user] = await getDb()
    .select({ enabled: users.taskSpawningEnabled })
    .from(users)
    .where(eq(users.workosUserId, userWorkosId))
    .limit(1);
  return user ? user.enabled : null;
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
