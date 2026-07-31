"use server";

import { randomUUID } from "node:crypto";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "@opencompany/db/client";
import type {
  GoatChatMessageAttachment,
  GoatHarnessEngine,
  GoatHarnessSpec,
  GoatTask,
} from "@opencompany/db/goat-schema";
import {
  goatTaskEvents,
  goatTaskMessages,
  goatTaskModelUsage,
  goatTaskSandboxUsage,
  goatTasks,
  goatTaskToolUsage,
  goatUsers,
} from "@opencompany/db/goat-schema";
import {
  createGoatTaskSession,
  enqueueGoatTaskSessionTurn,
  goatTaskSessionExecutionEnabled,
} from "@opencompany/db/goat-task-sessions";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";
import { TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { goatHomeActivityCutoff } from "@/lib/home-activity";
import { getGoatAvailableHarnessTools } from "@/lib/integrations/google-data";
import { normalizeGoatTaskName } from "@/lib/task-display";
import { triggerGoatCodexChatWake, triggerGoatTaskRun } from "@/lib/task-runner";
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
                WHERE message.session_id = ${task.sessionId}
                  AND message.role = 'assistant'
              ) AS "runDurationMs",
              (
                SELECT COUNT(*)
                FROM goat.credit_ledger AS ledger
                WHERE ledger.chat_session_id = ${task.sessionId}
                  AND ledger.user_workos_id = ${task.userWorkosId}
                  AND ledger.amount_usd_micros < 0
              ) AS "usageRowCount",
              (
                SELECT COALESCE(SUM(-ledger.amount_usd_micros), 0)
                FROM goat.credit_ledger AS ledger
                WHERE ledger.chat_session_id = ${task.sessionId}
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
  const now = new Date();
  const [sessionTask] = await getDb()
    .select({ sessionId: goatTasks.sessionId, userWorkosId: goatTasks.userWorkosId })
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
  if (sessionTask?.sessionId) {
    const result = await cancelSessionBackedGoatTask({
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
export async function continueGoatTaskAction(
  taskId: string,
  prompt: string,
  clientMessageId?: string,
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
  const [task] = await getDb()
    .select({ sessionId: goatTasks.sessionId, userWorkosId: goatTasks.userWorkosId })
    .from(goatTasks)
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
  if (task?.sessionId) {
    const continued = await enqueueGoatTaskSessionTurn({
      taskId: normalizedTaskId,
      userWorkosId: task.userWorkosId,
      prompt: content,
      clientMessageId,
    });
    if (!continued) {
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
    return { ok: true, error: null, messageId: continued.id };
  }

  const messageId = safeGoatTaskMessageId(clientMessageId) ?? `goat_task_msg_${randomUUID()}`;
  const now = new Date();
  const result = await getDb().execute(sql`
    WITH continued_task AS (
      UPDATE goat.tasks AS task
      SET status = 'queued',
          stage = 'queued',
          result = NULL,
          error = NULL,
          reported_outcome = NULL,
          outcome_comment = NULL,
          next_run_at = ${now},
          lease_id = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${now}
      WHERE task.id = ${normalizedTaskId}
        AND task.user_workos_id = ${task?.userWorkosId ?? user.workosUserId}
        AND (
          task.workspace_id = ${workspace.id}
          OR (task.workspace_id IS NULL AND task.user_workos_id = ${user.workosUserId})
        )
        AND task.archived_at IS NULL
        AND task.status IN ('succeeded', 'failed', 'canceled')
      RETURNING task.id, task.user_workos_id
    ),
    inserted_message AS (
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
        ${content},
        ${JSON.stringify({ role: "user", content })}::jsonb,
        ${now},
        ${now},
        ${now}
      FROM continued_task AS task
      RETURNING id, task_id, user_workos_id
    ),
    inserted_message_event AS (
      INSERT INTO goat.task_events (
        task_id,
        user_workos_id,
        message_id,
        type,
        payload,
        created_at
      )
      SELECT
        message.task_id,
        message.user_workos_id,
        message.id,
        'message.created',
        ${JSON.stringify({ role: "user", status: "completed" })}::jsonb,
        ${now}
      FROM inserted_message AS message
      RETURNING id
    ),
    inserted_status_event AS (
      INSERT INTO goat.task_events (
        task_id,
        user_workos_id,
        message_id,
        type,
        payload,
        created_at
      )
      SELECT
        message.task_id,
        message.user_workos_id,
        message.id,
        'task.status',
        ${JSON.stringify({ status: "queued", stage: "queued" })}::jsonb,
        ${now}
      FROM inserted_message AS message
      RETURNING id
    )
    SELECT message.id, message.task_id
    FROM inserted_message AS message
    WHERE EXISTS (SELECT 1 FROM inserted_message_event)
      AND EXISTS (SELECT 1 FROM inserted_status_event)
  `);
  const continued = rowsFromExecute<{ id: string; task_id: string }>(result)[0];
  if (!continued) {
    return {
      ok: false,
      error: "Wait for this task to finish before sending another message.",
      messageId: null,
    };
  }

  try {
    await triggerGoatTaskRun(continued.task_id, {
      task_id: continued.task_id,
      event: "goat.runner_task_continued_dispatch",
    });
  } catch (error) {
    console.warn("Goat runner dispatch failed; the continued task remains queued for polling.", {
      event: "goat.runner_task_continued_dispatch_failed",
      task_id: continued.task_id,
      error,
    });
  }

  return { ok: true, error: null, messageId: continued.id };
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
}) {
  const initialTaskSpawningState = await loadGoatTaskSpawningState(input.userWorkosId);
  if (initialTaskSpawningState === null) {
    throw new Error("Unable to create a Goat task for an unknown user.");
  }
  if (!initialTaskSpawningState) {
    throw new Error(TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE);
  }

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
  const sessionExecutionEnabled = goatTaskSessionExecutionEnabled();
  const attachments = input.attachments ?? [];
  if (sessionExecutionEnabled) {
    let task: GoatTask;
    try {
      task = await createGoatTaskSession({
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
      if (!(error instanceof Error) || error.message !== "Unable to create Goat task session.") {
        throw error;
      }
      const currentTaskSpawningState = await loadGoatTaskSpawningState(input.userWorkosId);
      if (currentTaskSpawningState === null) {
        throw new Error("Unable to create a Goat task for an unknown user.");
      }
      if (!currentTaskSpawningState) {
        throw new Error(TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE);
      }
      throw error;
    }
    await triggerGoatCodexChatWake().catch((error) => {
      console.warn("Goat durable task wake failed; the turn remains queued for polling.", {
        event: "goat.durable_task_created_wake_failed",
        task_id: task.id,
        error,
      });
    });
    return task;
  }
  if (attachments.length > 0) {
    throw new Error("Workflow attachments require durable task sessions.");
  }

  const modelMessage = { role: "user", content: input.prompt };
  const task = rowsFromExecute<GoatTaskRow>(
    await getDb().execute(sql`
      WITH created_task AS (
        INSERT INTO goat.tasks (
          id,
          name,
          user_workos_id,
          workspace_id,
          prompt,
          model,
          schedule_id,
          scheduled_for,
          workflow_id,
          workflow_brain_ref,
          status,
          stage,
          next_run_at,
          created_at,
          updated_at,
          harness_spec
        )
        SELECT
          ${id},
          ${name},
          ${input.userWorkosId},
          ${input.workspaceId ?? null},
          ${input.prompt},
          ${harnessSpec.model},
          ${input.scheduleId ?? null},
          ${input.scheduledFor ?? null},
          ${input.workflowId ?? null},
          ${input.workflowBrainRef ?? null},
          'queued',
          'queued',
          ${now},
          ${now},
          ${now},
          ${JSON.stringify(harnessSpec)}::jsonb
        FROM goat.users AS "user"
        WHERE "user".workos_user_id = ${input.userWorkosId}
          AND "user".task_spawning_enabled = true
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
        task.workspace_id AS "workspaceId",
        task.prompt AS "prompt",
        task.model AS "model",
        task.session_id AS "sessionId",
        task.schedule_id AS "scheduleId",
        task.scheduled_for AS "scheduledFor",
        task.workflow_id AS "workflowId",
        task.workflow_brain_ref AS "workflowBrainRef",
        task.status AS "status",
        task.stage AS "stage",
        task.result AS "result",
        task.error AS "error",
        task.reported_outcome AS "reportedOutcome",
        task.outcome_comment AS "outcomeComment",
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
      throw new Error(TASKS_WORKFLOWS_BETA_DISABLED_MESSAGE);
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

async function cancelSessionBackedGoatTask(input: {
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

function safeGoatTaskMessageId(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && /^goat_task_msg_[0-9a-f-]{36}$/i.test(trimmed) ? trimmed : null;
}

function goatTaskVisibleInWorkspace(input: { userWorkosId: string; workspaceId: string }) {
  return or(
    eq(goatTasks.workspaceId, input.workspaceId),
    and(eq(goatTasks.userWorkosId, input.userWorkosId), isNull(goatTasks.workspaceId)),
  );
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
