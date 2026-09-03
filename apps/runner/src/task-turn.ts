import { randomUUID } from "node:crypto";
import {
  UPDATE_TASK_STATUS_TOOL_DESCRIPTION,
  UPDATE_TASK_STATUS_TOOL_INPUT_JSON_SCHEMA,
} from "@opencompany/agent/chat-agent";
import {
  claudeCodeCliModelNameForModelId,
  codexCliModelNameForModelId,
  hostToolContractVersionForEngine,
} from "@opencompany/agent-runtime";
import {
  captureProductLlmUsageRecorded,
  captureProductModelSpendRecorded,
  captureProductServerEvent,
  productAnalyticsUsageSourceForEngine,
} from "@opencompany/analytics/product/server";
import { calculateModelUsageCost } from "@opencompany/billing";
import { RUN_EVENT_NOTIFY_CHANNEL } from "@opencompany/db/chat-repository";
import { recordCreditDebit } from "@opencompany/db/credits";
import { stringifyPostgresJson } from "@opencompany/db/postgres-json";
import {
  type CodexChatSession,
  type CodexChatSessionStatus,
  type CodexChatTurn,
  type CodexChatTurnSettings,
  type HarnessSpec,
  type HarnessWorkflowStep,
  type Task,
  type TaskReportedOutcome,
} from "@opencompany/db/product-schema";
import { createLogger } from "@opencompany/observability";
import {
  createGatewayAttribution,
  gatewayProviderOptions,
  recordModelCost,
  recordModelUsageTokens,
} from "@opencompany/telemetry";
import * as ai from "ai";
import { createGateway, jsonSchema, type LanguageModelUsage } from "ai";
import { sql } from "drizzle-orm";
import { createBrainMarkdownReportForTask } from "./brain";
import { CodexChatLeaseLostError, TaskTurnTerminalError } from "./codex-chat-errors";
import {
  type CodexChatScheduledWakeup,
  prepareCodexChatScheduledWakeup,
} from "./codex-chat-wakeup";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { getAvailableGitHubRepositoryNamesForRunner } from "./harness-planner";
import { rowsFromExecute } from "./sql-exec";
import { systemBlocksForTaskResultMode, systemPromptForTaskResultMode } from "./task-result-mode";
import { normalizeTaskToolNames } from "./task-tool-names";

const TASK_OUTCOME_COMMENT_MAX_LENGTH = 200;
const TASK_CLOSER_MODEL = "openai/gpt-5.4-mini";
const CODING_ERROR_MAX_LENGTH = 2_000;
const logger = createLogger({ service: "opencompany-runner", runtime: "task-turn" });

export type TaskTurnContext = {
  task: Task;
  harnessSpec: HarnessSpec;
};

export type TaskTurnCompletion = {
  taskId: string;
  taskDisplayId: string;
  taskName: string;
  harnessSpec: HarnessSpec;
  result: string;
  reportedOutcome: TaskReportedOutcome | null;
  outcomeComment: string | null;
  nextTurn: TaskNextTurn | null;
};

export function resolveTaskTurnContext(task: Task, turn: CodexChatTurn): TaskTurnContext {
  const resultMode = turn.settings.taskResultMode;
  if (!resultMode || resultMode === task.harnessSpec.resultMode) {
    return { task, harnessSpec: task.harnessSpec };
  }
  return {
    task,
    harnessSpec: {
      ...task.harnessSpec,
      resultMode,
      systemPrompt: systemPromptForTaskResultMode(task.harnessSpec.systemPrompt, resultMode),
      ...(task.harnessSpec.systemBlocks
        ? {
            systemBlocks: systemBlocksForTaskResultMode(task.harnessSpec.systemBlocks, resultMode),
          }
        : {}),
    },
  };
}

type TaskNextTurn = {
  id: string;
  userMessageId: string;
  assistantMessageId: string;
  prompt: string;
  userMessageContent?: string;
  userMessageDebugTrace?: Record<string, unknown>;
  runAfter?: Date;
  harnessSpec: HarnessSpec;
  engine: HarnessSpec["engine"];
  chatModel: string;
  runtimeModel: string;
  hostToolContractVersion: string;
  settings: CodexChatTurnSettings;
  assistantDebugTrace: Record<string, unknown>;
};

export async function markTaskTurnRunning(input: {
  context: TaskTurnContext;
  turn: CodexChatTurn;
  stage?: "planning" | "running";
}) {
  const result = await getDb().execute(sql`
    WITH updated_task AS (
      UPDATE goat.tasks AS task
      SET status = 'running',
          stage = ${input.stage ?? "running"},
          result = NULL,
          error = NULL,
          reported_outcome = NULL,
          outcome_comment = NULL,
          attempts = CASE WHEN task.status = 'queued' THEN task.attempts + 1 ELSE task.attempts END,
          updated_at = ${new Date()}
      WHERE task.id = ${input.context.task.id}
        AND task.session_id = ${input.turn.chatSessionId}
        AND task.user_workos_id = ${input.turn.userWorkosId}
        AND task.status IN ('queued', 'running')
        AND EXISTS (${turnLeaseSubquery(input.turn)})
      RETURNING task.id
    )
    SELECT 'updated'::text AS outcome
    FROM updated_task
    UNION ALL
    SELECT 'terminal'::text AS outcome
    FROM goat.tasks AS task
    WHERE task.id = ${input.context.task.id}
      AND task.session_id = ${input.turn.chatSessionId}
      AND task.user_workos_id = ${input.turn.userWorkosId}
      AND task.status IN ('succeeded', 'failed', 'canceled')
      AND EXISTS (${turnLeaseSubquery(input.turn)})
    LIMIT 1
  `);
  assertTaskMutationSucceeded(result);
}

export async function prepareCodexTaskTurn(input: {
  context: TaskTurnContext;
  turn: CodexChatTurn;
  session: CodexChatSession;
  env: RunnerEnv;
  signal: AbortSignal;
}): Promise<TaskTurnContext> {
  await markTaskTurnRunning({ context: input.context, turn: input.turn, stage: "planning" });
  const task = input.context.task;
  const preplanned = hasPreplannedHarnessSpec(task.harnessSpec);
  if (preplanned) {
    await markTaskTurnRunning({ context: input.context, turn: input.turn });
    return input.context;
  }

  const githubRepositories = task.harnessSpec.tools.some((tool) => tool.startsWith("github_"))
    ? await getAvailableGitHubRepositoryNamesForRunner(task.userWorkosId)
    : [];
  const { PLANNER_MODEL, planHarnessForTask } = await import("./harness");
  const planned = await planHarnessForTask({
    prompt: task.prompt,
    model: task.model,
    requestedEngine: "codex",
    availableTools: normalizeTaskToolNames(task.harnessSpec.tools),
    githubRepositories,
    gatewayApiKey: input.env.vercelAiGatewayApiKey,
    userWorkosId: task.userWorkosId,
    taskId: task.id,
    signal: input.signal,
  });
  if (planned.usage) {
    await recordTaskGatewayUsage({
      context: input.context,
      session: input.session,
      turn: input.turn,
      model: PLANNER_MODEL,
      usage: planned.usage,
      phase: "planner",
    });
  }
  const harnessSpec = planned.harnessSpec;
  const runtimeModel = codexCliModelNameForModelId(harnessSpec.model);
  if (!runtimeModel) {
    throw new Error(`Unsupported Codex task model: ${harnessSpec.model}`);
  }
  const now = new Date();
  const result = await getDb().execute(sql`
    WITH updated_task AS (
      UPDATE goat.tasks AS task
      SET status = 'running',
          stage = 'running',
          model = ${harnessSpec.model},
          harness_spec = ${stringifyPostgresJson(harnessSpec)}::jsonb,
          debug_trace = ${stringifyPostgresJson(planned.debugTrace)}::jsonb,
          updated_at = ${now}
      WHERE task.id = ${task.id}
        AND task.session_id = ${input.turn.chatSessionId}
        AND task.user_workos_id = ${input.turn.userWorkosId}
        AND task.status = 'running'
        AND EXISTS (${turnLeaseSubquery(input.turn)})
      RETURNING task.id
    ),
    updated_runtime AS (
      UPDATE goat.codex_chat_sessions AS runtime
      SET model = ${runtimeModel},
          updated_at = ${now}
      WHERE runtime.id = ${input.session.id}
        AND runtime.engine = 'codex'
        AND EXISTS (SELECT 1 FROM updated_task)
      RETURNING runtime.chat_session_id
    ),
    updated_chat AS (
      UPDATE goat.chat_sessions AS chat
      SET model = ${harnessSpec.model},
          updated_at = ${now}
      FROM updated_runtime AS runtime
      WHERE chat.id = runtime.chat_session_id
      RETURNING chat.id
    )
    SELECT 'updated'::text AS outcome
    FROM updated_chat
    UNION ALL
    SELECT 'terminal'::text AS outcome
    FROM goat.tasks AS task
    WHERE task.id = ${task.id}
      AND task.session_id = ${input.turn.chatSessionId}
      AND task.user_workos_id = ${input.turn.userWorkosId}
      AND task.status IN ('succeeded', 'failed', 'canceled')
      AND EXISTS (${turnLeaseSubquery(input.turn)})
    LIMIT 1
  `);
  assertTaskMutationSucceeded(result);
  return {
    task: {
      ...task,
      status: "running",
      stage: "running",
      model: harnessSpec.model,
      harnessSpec,
      debugTrace: planned.debugTrace,
      updatedAt: now,
    },
    harnessSpec,
  };
}

export async function closeTaskTurn(input: {
  context: TaskTurnContext;
  finalContent: string;
  env: RunnerEnv;
  session: CodexChatSession;
  turn: CodexChatTurn;
  signal: AbortSignal;
}): Promise<{
  reportedOutcome: TaskReportedOutcome;
  outcomeComment: string;
} | null> {
  try {
    const workflow = input.context.harnessSpec.workflow;
    const currentStepIndex = workflow?.currentStepIndex ?? 0;
    const currentStep = workflow?.steps?.[currentStepIndex];
    const gateway = createGateway({ apiKey: input.env.vercelAiGatewayApiKey });
    const { getBraintrustAISDK } = await import("@opencompany/observability/braintrust");
    const { generateText } = getBraintrustAISDK(ai);
    const result = await generateText({
      model: gateway(TASK_CLOSER_MODEL),
      system: currentStep
        ? 'You close one finished step in a sequential background workflow. Judge whether this step\'s own instructions were completed ("done") or the user should look at it ("needs_attention"). Do not penalize it because later workflow steps remain. Always call update_task_status exactly once.'
        : 'You close a finished autonomous background task. Decide whether it is complete ("done") or the user should look at it ("needs_attention": partial results, blockers, errors, questions, or requested review). Always call update_task_status exactly once.',
      prompt: [
        `Task: ${input.context.task.name}`,
        "",
        "Task request:",
        input.context.task.prompt,
        ...(currentStep
          ? [
              "",
              `Current workflow step: ${currentStepIndex + 1}/${workflow?.steps?.length ?? 1} — ${currentStep.title.trim() || "Untitled step"}`,
              "",
              "Step instructions:",
              currentStep.systemPrompt.slice(0, 12_000),
            ]
          : []),
        "",
        "Result:",
        input.finalContent.slice(0, 12_000),
        "",
        "Call update_task_status now with a short, one-sentence plain-text comment.",
      ].join("\n"),
      tools: {
        update_task_status: ai.tool({
          description: UPDATE_TASK_STATUS_TOOL_DESCRIPTION,
          inputSchema: jsonSchema<{
            status: TaskReportedOutcome;
            comment: string;
          }>(UPDATE_TASK_STATUS_TOOL_INPUT_JSON_SCHEMA),
        }),
      },
      toolChoice: "required",
      abortSignal: input.signal,
      providerOptions: gatewayProviderOptions(
        createGatewayAttribution({
          userWorkosId: input.context.task.userWorkosId,
          feature: "task",
          taskId: input.context.task.id,
        }),
      ),
    });
    const call = result.toolCalls.find((toolCall) => toolCall.toolName === "update_task_status");
    await recordTaskGatewayUsage({
      context: input.context,
      session: input.session,
      turn: input.turn,
      model: TASK_CLOSER_MODEL,
      usage: result.usage,
      phase: "closer",
    });
    return readTaskOutcome(call?.input);
  } catch (error) {
    if (input.signal.aborted) {
      throw input.signal.reason instanceof Error ? input.signal.reason : error;
    }
    console.warn("opencompany task closer failed; the task completes without a reported outcome.", {
      event: "goat.task_closer_failed",
      task_id: input.context.task.id,
      error,
    });
    return null;
  }
}

export async function finalizeTaskResult(input: {
  context: TaskTurnContext;
  assistantContent: string;
  turnId?: string | undefined;
}) {
  const content = input.assistantContent.trim();
  if (input.context.harnessSpec.resultMode !== "brain_markdown_report") return content;
  const artifact = await createBrainMarkdownReportForTask({
    userWorkosId: input.context.task.userWorkosId,
    taskId: input.context.task.id,
    taskTurnId: input.turnId,
    title: input.context.task.name,
    markdown: content,
  });
  return [
    `Research report saved to Brain: [${artifact.title}](${artifact.url}).`,
    "",
    `Artifact: \`${artifact.brainPath}\``,
  ].join("\n");
}

export function buildTaskTurnCompletion(input: {
  context: TaskTurnContext;
  result: string;
  reportedOutcome?: TaskReportedOutcome | null | undefined;
  outcomeComment?: string | null | undefined;
  scheduledWakeup?:
    | {
        wakeup: CodexChatScheduledWakeup;
        parentSettings: CodexChatTurnSettings;
        now?: Date;
      }
    | undefined;
}): TaskTurnCompletion {
  const workflow = input.context.harnessSpec.workflow;
  const reportedOutcome = input.reportedOutcome ?? null;
  const preparedScheduledWakeup = input.scheduledWakeup
    ? prepareCodexChatScheduledWakeup({
        parentSettings: input.scheduledWakeup.parentSettings,
        wakeup: input.scheduledWakeup.wakeup,
        ...(input.scheduledWakeup.now ? { now: input.scheduledWakeup.now } : {}),
      })
    : null;
  let outcomeComment =
    input.outcomeComment?.trim().slice(0, TASK_OUTCOME_COMMENT_MAX_LENGTH) || null;
  let harnessSpec = input.context.task.harnessSpec;
  let nextTurn: TaskNextTurn | null = null;

  if (workflow?.steps?.length) {
    const currentStepIndex = workflow.currentStepIndex ?? workflow.completedStepCount ?? 0;
    const currentStep = workflow.steps[currentStepIndex];
    const completedStepCount = Math.min(workflow.steps.length, currentStepIndex + 1);
    if (reportedOutcome === "needs_attention" && currentStepIndex < workflow.steps.length - 1) {
      const label = currentStep?.title.trim()
        ? `Step ${currentStepIndex + 1} (${currentStep.title.trim()})`
        : `Step ${currentStepIndex + 1}`;
      outcomeComment =
        `${label}: ${outcomeComment || "Needs attention before the workflow can continue."}`.slice(
          0,
          TASK_OUTCOME_COMMENT_MAX_LENGTH,
        );
    }
    harnessSpec = {
      ...harnessSpec,
      workflow: {
        ...workflow,
        completedStepCount,
        lastCompletedStepOutcome: {
          reportedOutcome,
          outcomeComment,
        },
      },
    };
    const nextStep = workflow.steps[currentStepIndex + 1];
    // Match the legacy workflow runner: only an explicit needs_attention
    // outcome blocks the sequence. A missing closer/tool outcome must not
    // strand a multi-step workflow after an otherwise successful turn.
    if (reportedOutcome !== "needs_attention" && nextStep && !preparedScheduledWakeup) {
      const { codex: _previousCodexConfig, ...harnessSpecWithoutCodex } = harnessSpec;
      const nextStepCodexConfig = codexConfigForWorkflowStep(harnessSpec.codex, nextStep);
      const nextHarnessSpec: HarnessSpec = {
        ...harnessSpecWithoutCodex,
        engine: nextStep.engine,
        model: nextStep.model,
        ...(nextStepCodexConfig ? { codex: nextStepCodexConfig } : {}),
        systemPrompt: systemPromptForTaskResultMode(nextStep.systemPrompt, harnessSpec.resultMode),
        systemBlocks: systemBlocksForTaskResultMode(nextStep.systemBlocks, harnessSpec.resultMode),
        workflow: {
          ...harnessSpec.workflow!,
          currentStepIndex: currentStepIndex + 1,
        },
      };
      nextTurn = createNextTaskTurn({
        harnessSpec: nextHarnessSpec,
        prompt: workflowStepHandoffContent({
          stepIndex: currentStepIndex + 1,
          stepCount: workflow.steps.length,
          title: nextStep.title,
          previousResult: input.result,
        }),
      });
      harnessSpec = nextHarnessSpec;
    }
  }

  if (preparedScheduledWakeup) {
    nextTurn = createNextTaskTurn({
      harnessSpec,
      prompt: preparedScheduledWakeup.prompt,
      userMessageContent: preparedScheduledWakeup.userMessageContent,
      userMessageDebugTrace: preparedScheduledWakeup.userDebugTrace,
      runAfter: preparedScheduledWakeup.dueAt,
      settings: preparedScheduledWakeup.settings,
    });
  }

  return {
    taskId: input.context.task.id,
    taskDisplayId: input.context.task.displayId,
    taskName: input.context.task.name,
    harnessSpec,
    result: input.result.trim(),
    reportedOutcome,
    outcomeComment,
    nextTurn,
  };
}

export function buildTaskTerminalProjection(context: TaskTurnContext): TaskTurnCompletion {
  return {
    taskId: context.task.id,
    taskDisplayId: context.task.displayId,
    taskName: context.task.name,
    harnessSpec: context.task.harnessSpec,
    result: "",
    reportedOutcome: null,
    outcomeComment: null,
    nextTurn: null,
  };
}

export async function settleDurableTurn(input: {
  target: {
    userWorkosId: string;
    workspaceId?: string | null;
    codexChatSessionId: string;
    chatSessionId: string;
    turnId: string;
    leaseId: string;
    leaseOwner: string;
  };
  turnStatus: "completed" | "failed" | "interrupted";
  sessionStatus: CodexChatSessionStatus;
  error: string | null;
  completedAt: Date;
  taskCompletion?: TaskTurnCompletion | null | undefined;
  canonicalRun?: {
    attemptId: string;
    assistantMessageId: string;
    content: string;
    failureDiagnostic?: string;
  };
}) {
  const { target } = input;
  const normalizedError = input.error?.slice(0, CODING_ERROR_MAX_LENGTH) ?? null;
  const normalizedFailureDiagnostic =
    input.canonicalRun?.failureDiagnostic?.slice(0, CODING_ERROR_MAX_LENGTH) ?? null;
  if (input.error && input.error.length > CODING_ERROR_MAX_LENGTH) {
    logger.warn("Normalized overlong coding error before durable settlement", {
      event: "opencompany.runner_coding_error_normalized",
      field: "error",
      original_length: input.error.length,
      max_length: CODING_ERROR_MAX_LENGTH,
    });
  }
  if (
    input.canonicalRun?.failureDiagnostic &&
    input.canonicalRun.failureDiagnostic.length > CODING_ERROR_MAX_LENGTH
  ) {
    logger.warn("Normalized overlong coding error before durable settlement", {
      event: "opencompany.runner_coding_error_normalized",
      field: "failure_diagnostic",
      original_length: input.canonicalRun.failureDiagnostic.length,
      max_length: CODING_ERROR_MAX_LENGTH,
    });
  }
  const completion = input.taskCompletion ?? null;
  const next = completion?.nextTurn ?? null;
  const terminalTaskStatus =
    input.turnStatus === "completed"
      ? "succeeded"
      : input.turnStatus === "interrupted"
        ? "canceled"
        : "failed";
  const terminalTaskStage =
    input.turnStatus === "completed"
      ? "completed"
      : input.turnStatus === "interrupted"
        ? "canceled"
        : "failed";
  const notificationId = `goat_chat_msg_${randomUUID()}`;
  const nextRunEventId = `run_event_${randomUUID()}`;
  const notificationContent = completion
    ? input.turnStatus === "completed"
      ? taskSucceededNotification(completion.taskDisplayId, completion.result)
      : input.turnStatus === "failed"
        ? taskFailedNotification(completion.taskDisplayId, normalizedError ?? "")
        : null
    : null;
  const canonicalEvents = input.canonicalRun
    ? [
        {
          id: `run_event_${randomUUID()}`,
          type: "message.content_updated",
          payload: {
            messageId: input.canonicalRun.assistantMessageId,
            content: input.canonicalRun.content,
            complete: true,
          },
        },
        input.turnStatus === "completed"
          ? {
              id: `run_event_${randomUUID()}`,
              type: "run.completed",
              payload: { messageId: input.canonicalRun.assistantMessageId },
            }
          : input.turnStatus === "interrupted"
            ? {
                id: `run_event_${randomUUID()}`,
                type: "run.canceled",
                payload: { by: "user" },
              }
            : {
                id: `run_event_${randomUUID()}`,
                type: "run.failed",
                payload: {
                  code: "execution_failed",
                  message: normalizedError ?? "Chat execution failed.",
                  retryable: false,
                },
              },
      ]
    : [];
  const canonicalAttemptStatus =
    input.turnStatus === "completed"
      ? "completed"
      : input.turnStatus === "interrupted"
        ? "canceled"
        : "failed";

  const result = await getDb().execute(sql`
    WITH settled_turn AS (
      UPDATE goat.codex_chat_turns AS turn
      SET status = ${input.turnStatus},
          error = ${normalizedError},
          completed_at = ${input.completedAt},
          event_sequence = turn.event_sequence + ${canonicalEvents.length},
          updated_at = ${input.completedAt}
      WHERE turn.id = ${target.turnId}
        AND turn.user_workos_id = ${target.userWorkosId}
        AND turn.lease_id = ${target.leaseId}
        AND turn.lease_owner = ${target.leaseOwner}
        AND turn.status = 'running'
        AND (
          NOT ${Boolean(input.canonicalRun)}
          OR EXISTS (
            SELECT 1
            FROM goat.run_attempts AS attempt
            WHERE attempt.id = ${input.canonicalRun?.attemptId ?? null}
              AND attempt.run_id = turn.id
              AND attempt.status = 'running'
              AND attempt.lease_id = ${target.leaseId}
              AND attempt.worker_id = ${target.leaseOwner}
          )
        )
      RETURNING turn.id, turn.event_sequence - ${canonicalEvents.length} AS base_sequence
    ),
    finished_canonical_attempt AS (
      UPDATE goat.run_attempts AS attempt
      SET status = ${canonicalAttemptStatus},
          error_code = ${input.turnStatus === "failed" ? "execution_failed" : null},
          error_message = ${
            input.turnStatus === "failed" ? (normalizedFailureDiagnostic ?? normalizedError) : null
          },
          completed_at = ${input.completedAt}
      FROM settled_turn AS run
      WHERE attempt.id = ${input.canonicalRun?.attemptId ?? null}
        AND attempt.run_id = run.id
        AND attempt.status = 'running'
        AND attempt.lease_id = ${target.leaseId}
      RETURNING attempt.id
    ),
    canonical_event_input AS MATERIALIZED (
      SELECT
        item.value ->> 'id' AS id,
        item.value ->> 'type' AS type,
        item.value -> 'payload' AS payload,
        item.ordinality
      FROM jsonb_array_elements(${stringifyPostgresJson(canonicalEvents)}::jsonb)
        WITH ORDINALITY AS item(value, ordinality)
    ),
    inserted_canonical_events AS (
      INSERT INTO goat.run_events (
        id, run_id, attempt_id, sequence, schema_version, type, payload, created_at
      )
      SELECT
        event.id,
        run.id,
        ${input.canonicalRun?.attemptId ?? null},
        run.base_sequence + event.ordinality,
        1,
        event.type,
        event.payload,
        ${input.completedAt}
      FROM canonical_event_input AS event
      CROSS JOIN settled_turn AS run
      WHERE EXISTS (SELECT 1 FROM finished_canonical_attempt)
      RETURNING run_id, sequence
    ),
    notified_canonical_events AS MATERIALIZED (
      SELECT pg_notify(
        ${RUN_EVENT_NOTIFY_CHANNEL},
        jsonb_build_object('runId', run_id, 'sequence', max(sequence))::text
      )
      FROM inserted_canonical_events
      GROUP BY run_id
    ),
    canonical_settlement_guard AS MATERIALIZED (
      SELECT CASE
        WHEN NOT ${Boolean(input.canonicalRun)}
          OR (
            EXISTS (SELECT 1 FROM finished_canonical_attempt)
            AND (SELECT COUNT(*) FROM inserted_canonical_events) = ${canonicalEvents.length}
            AND (SELECT COUNT(*) FROM notified_canonical_events) = 1
          )
        THEN 1
        ELSE jsonb_array_length(jsonb_build_object('reason', 'canonical_settlement_failed'))
      END AS materialized
      FROM settled_turn
    ),
    projected_task AS (
      UPDATE goat.tasks AS task
      SET status = CASE WHEN ${Boolean(next)} THEN 'running' ELSE ${terminalTaskStatus} END,
          stage = CASE WHEN ${Boolean(next)} THEN 'queued' ELSE ${terminalTaskStage} END,
          model = COALESCE(${completion?.harnessSpec.model ?? null}, task.model),
          result = CASE
            WHEN ${Boolean(next)} THEN task.result
            WHEN ${input.turnStatus} = 'completed' THEN ${completion?.result ?? null}
            ELSE task.result
          END,
          error = CASE
            WHEN ${Boolean(next)} THEN NULL
            WHEN ${input.turnStatus} = 'completed' THEN NULL
            WHEN ${input.turnStatus} = 'interrupted' THEN 'Stopped by user.'
            ELSE ${normalizedError}
          END,
          reported_outcome = CASE WHEN ${Boolean(next)}
            THEN NULL
            ELSE ${completion?.reportedOutcome ?? null}
          END,
          outcome_comment = CASE WHEN ${Boolean(next)}
            THEN NULL
            ELSE ${completion?.outcomeComment ?? null}
          END,
          harness_spec = COALESCE(
            ${completion ? stringifyPostgresJson(completion.harnessSpec) : null}::jsonb,
            task.harness_spec
          ),
          updated_at = ${input.completedAt}
      WHERE task.id = ${completion?.taskId ?? null}
        AND task.session_id = ${target.chatSessionId}
        AND task.user_workos_id = ${target.userWorkosId}
        AND task.status IN ('queued', 'running')
        AND EXISTS (SELECT 1 FROM settled_turn)
      RETURNING task.*
    ),
    tagged_current_task_messages AS (
      UPDATE goat.chat_messages AS message
      SET task_id = task.id,
          updated_at = ${input.completedAt}
      FROM projected_task AS task
      WHERE message.session_id = ${target.chatSessionId}
        AND message.task_id IS NULL
      RETURNING message.id
    ),
    next_user_message AS (
      INSERT INTO goat.chat_messages (
        id,
        session_id,
        role,
        content,
        task_id,
        debug_trace,
        attachments,
        attachment_texts,
        created_at,
        updated_at
      )
      SELECT
        ${next?.userMessageId ?? null},
        task.session_id,
        'user',
        ${next?.userMessageContent ?? next?.prompt ?? null},
        task.id,
        ${
          next?.userMessageDebugTrace ? stringifyPostgresJson(next.userMessageDebugTrace) : null
        }::jsonb,
        NULL,
        NULL,
        ${input.completedAt},
        ${input.completedAt}
      FROM projected_task AS task
      WHERE ${Boolean(next)}
      RETURNING id
    ),
    next_assistant_message AS (
      INSERT INTO goat.chat_messages (
        id, session_id, role, content, task_id, debug_trace, created_at, updated_at
      )
      SELECT
        ${next?.assistantMessageId ?? null},
        task.session_id,
        'assistant',
        '',
        task.id,
        ${next ? stringifyPostgresJson(next.assistantDebugTrace) : null}::jsonb,
        ${new Date(input.completedAt.getTime() + 1)},
        ${new Date(input.completedAt.getTime() + 1)}
      FROM projected_task AS task
      WHERE ${Boolean(next)}
      RETURNING id
    ),
    next_turn AS (
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
        run_after,
        event_sequence,
        created_at,
        updated_at
      )
      SELECT
        ${next?.id ?? null},
        task.user_workos_id,
        ${target.codexChatSessionId},
        task.session_id,
        ${next?.userMessageId ?? null},
        ${next?.assistantMessageId ?? null},
        'queued',
        ${next?.prompt ?? null},
        ${next ? stringifyPostgresJson(next.settings) : null}::jsonb,
        ${next?.runAfter ?? null},
        1,
        ${new Date(input.completedAt.getTime() + 2)},
        ${new Date(input.completedAt.getTime() + 2)}
      FROM projected_task AS task
      WHERE ${Boolean(next)}
        AND EXISTS (SELECT 1 FROM next_user_message)
        AND EXISTS (SELECT 1 FROM next_assistant_message)
      RETURNING id, chat_session_id, user_message_id
    ),
    next_queued_event AS MATERIALIZED (
      INSERT INTO goat.run_events (
        id, run_id, sequence, schema_version, type, payload, created_at
      )
      SELECT
        ${nextRunEventId}, next.id, 1, 1, 'run.queued',
        jsonb_build_object(
          'conversationId', next.chat_session_id,
          'triggerMessageId', next.user_message_id
        ),
        ${new Date(input.completedAt.getTime() + 2)}
      FROM next_turn AS next
      RETURNING run_id, sequence
    ),
    notified_next_queued_event AS MATERIALIZED (
      SELECT pg_notify(
        ${RUN_EVENT_NOTIFY_CHANNEL},
        jsonb_build_object('runId', run_id, 'sequence', sequence)::text
      )
      FROM next_queued_event
    ),
    next_queued_turn AS (
      SELECT next.id
      FROM next_turn AS next
      UNION ALL
      (
        SELECT queued.id
        FROM goat.codex_chat_turns AS queued
        WHERE queued.codex_chat_session_id = ${target.codexChatSessionId}
          AND queued.user_workos_id = ${target.userWorkosId}
          AND queued.status = 'queued'
          AND (queued.run_after IS NULL OR queued.run_after <= ${input.completedAt})
          AND EXISTS (SELECT 1 FROM settled_turn)
          AND NOT EXISTS (SELECT 1 FROM next_turn)
        ORDER BY queued.created_at ASC, queued.id ASC
        LIMIT 1
      )
    ),
    updated_runtime AS (
      UPDATE goat.codex_chat_sessions AS runtime
      SET active_turn_id = (SELECT id FROM next_queued_turn),
          status = CASE
            WHEN EXISTS (SELECT 1 FROM next_queued_turn)
              THEN 'queued'
            ELSE ${input.sessionStatus}
          END,
          engine = COALESCE(${next?.engine ?? null}, runtime.engine),
          model = COALESCE(${next?.runtimeModel ?? null}, runtime.model),
          codex_thread_id = CASE
            WHEN ${Boolean(next)}::boolean
              AND ${next?.engine ?? null}::text IS DISTINCT FROM runtime.engine
              THEN NULL
            ELSE runtime.codex_thread_id
          END,
          host_tool_contract_version = CASE
            WHEN ${Boolean(next)} THEN ${next?.hostToolContractVersion ?? null}
            ELSE runtime.host_tool_contract_version
          END,
          error = ${normalizedError},
          updated_at = ${input.completedAt}
      WHERE runtime.id = ${target.codexChatSessionId}
        AND runtime.user_workos_id = ${target.userWorkosId}
        AND (runtime.active_turn_id IS NULL OR runtime.active_turn_id = ${target.turnId})
        AND EXISTS (SELECT 1 FROM settled_turn)
      RETURNING runtime.id, runtime.chat_session_id, runtime.status
    ),
    updated_task_chat AS (
      UPDATE goat.chat_sessions AS chat
      SET engine = COALESCE(${next?.engine ?? null}, chat.engine),
          model = COALESCE(${next?.chatModel ?? null}, chat.model),
          has_unseen = CASE
            WHEN runtime.status = 'queued' THEN chat.has_unseen
            ELSE true
          END,
          updated_at = ${input.completedAt}
      FROM updated_runtime AS runtime
      WHERE chat.id = runtime.chat_session_id
        AND chat.user_workos_id = ${target.userWorkosId}
      RETURNING chat.id
    ),
    origin_chat AS (
      SELECT origin.session_id
      FROM goat.chat_messages AS origin
      INNER JOIN goat.chat_sessions AS chat
        ON chat.id = origin.session_id
       AND chat.kind = 'chat'
       AND chat.closed_at IS NULL
      INNER JOIN projected_task AS task
        ON task.id = origin.task_id
      WHERE ${notificationContent}::text IS NOT NULL
        AND NOT ${Boolean(next)}
      ORDER BY origin.created_at ASC
      LIMIT 1
    ),
    inserted_notification AS (
      INSERT INTO goat.chat_messages (
        id, session_id, role, content, debug_trace, created_at, updated_at
      )
      SELECT
        ${notificationId},
        origin.session_id,
        'assistant',
        ${notificationContent},
        jsonb_build_object(
          'schemaVersion', 'goat.chat.debug.v1',
          'taskNotification', jsonb_build_object(
            'taskId', task.id,
            'taskDisplayId', task.display_id,
            'taskName', task.name,
            'status', task.status
          ),
          'error', task.error
        ),
        ${input.completedAt},
        ${input.completedAt}
      FROM origin_chat AS origin
      CROSS JOIN projected_task AS task
      WHERE NOT EXISTS (
        SELECT 1
        FROM goat.chat_messages AS existing
        WHERE existing.session_id = origin.session_id
          AND existing.debug_trace->'taskNotification'->>'taskId' = task.id
      )
      RETURNING session_id
    ),
    touched_origin_chat AS (
      UPDATE goat.chat_sessions AS chat
      SET has_unseen = true, updated_at = ${input.completedAt}
      FROM inserted_notification AS notification
      WHERE chat.id = notification.session_id
      RETURNING chat.id
    )
    SELECT runtime.id
    FROM updated_runtime AS runtime
    CROSS JOIN canonical_settlement_guard AS canonical_guard
    WHERE EXISTS (SELECT 1 FROM updated_task_chat)
      AND canonical_guard.materialized = 1
      AND (
        NOT ${Boolean(next)}
        OR (
          EXISTS (SELECT 1 FROM next_turn)
          AND EXISTS (SELECT 1 FROM next_queued_event)
          AND EXISTS (SELECT 1 FROM notified_next_queued_event)
        )
      )
  `);
  assertRowsChanged(result);
  await captureWorkflowHandoffChatMessageSent({ target, next });
}

async function captureWorkflowHandoffChatMessageSent(input: {
  target: {
    userWorkosId: string;
    workspaceId?: string | null;
    chatSessionId: string;
  };
  next: TaskNextTurn | null;
}) {
  const workspaceId = input.target.workspaceId?.trim();
  if (!workspaceId || !input.next) return;
  const messageContent = input.next.userMessageContent ?? input.next.prompt;
  await captureProductServerEvent("chat_message_sent", input.target.userWorkosId, {
    workspace_id: workspaceId,
    session_id: input.target.chatSessionId,
    is_first_message: false,
    engine: input.next.engine,
    usage_source: productAnalyticsUsageSourceForEngine(input.next.engine),
    model: input.next.chatModel,
    message_length: messageContent.length,
  });
}

function createNextTaskTurn(input: {
  harnessSpec: HarnessSpec;
  prompt: string;
  userMessageContent?: string;
  userMessageDebugTrace?: Record<string, unknown>;
  runAfter?: Date;
  settings?: CodexChatTurnSettings;
}): TaskNextTurn {
  const runtimeModel = runtimeModelNameForHarness(
    input.harnessSpec.engine,
    input.harnessSpec.model,
  );
  if (!runtimeModel) {
    throw new Error(
      `Unsupported ${input.harnessSpec.engine} workflow model: ${input.harnessSpec.model}`,
    );
  }
  return {
    id: `goat_codex_chat_turn_${randomUUID()}`,
    userMessageId: `goat_chat_msg_${randomUUID()}`,
    assistantMessageId: `goat_chat_msg_${randomUUID()}`,
    prompt: input.prompt,
    ...(input.userMessageContent ? { userMessageContent: input.userMessageContent } : {}),
    ...(input.userMessageDebugTrace ? { userMessageDebugTrace: input.userMessageDebugTrace } : {}),
    ...(input.runAfter ? { runAfter: input.runAfter } : {}),
    harnessSpec: input.harnessSpec,
    engine: input.harnessSpec.engine,
    chatModel: input.harnessSpec.model,
    runtimeModel,
    hostToolContractVersion: hostToolContractVersionForEngine(input.harnessSpec.engine),
    settings: input.settings ?? {
      ...(input.harnessSpec.codex?.reasoningEffort
        ? { reasoningEffort: input.harnessSpec.codex.reasoningEffort }
        : {}),
      ...(input.harnessSpec.codex?.goalMode ? { goalMode: input.harnessSpec.codex.goalMode } : {}),
    },
    assistantDebugTrace: {
      schemaVersion:
        input.harnessSpec.engine === "opencompany"
          ? "opencompany.chat.debug.v1"
          : "goat.codex_chat.debug.v1",
      model: runtimeModel,
      uiMessageParts: [],
    },
  };
}

function runtimeModelNameForHarness(engine: HarnessSpec["engine"], model: string) {
  if (engine === "codex") return codexCliModelNameForModelId(model);
  if (engine === "claude_code") return claudeCodeCliModelNameForModelId(model);
  return model;
}

function codexConfigForWorkflowStep(
  base: HarnessSpec["codex"],
  step: HarnessWorkflowStep,
): HarnessSpec["codex"] | undefined {
  if (step.engine !== "codex" && step.engine !== "claude_code") return undefined;
  const { reasoningEffort: baseReasoningEffort, ...rest } = base ?? {};
  const reasoningEffort = step.reasoningEffort ?? baseReasoningEffort;
  const next = {
    ...rest,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

function workflowStepHandoffContent(input: {
  stepIndex: number;
  stepCount: number;
  title: string;
  previousResult: string;
}) {
  const heading = `Step ${input.stepIndex + 1}/${input.stepCount} — ${input.title.trim() || "Untitled step"}`;
  if (!input.previousResult.trim()) return heading;
  return [
    heading,
    "",
    "Continue the workflow using the previous step's result:",
    "",
    "<previous_step_result>",
    input.previousResult.trim(),
    "</previous_step_result>",
  ].join("\n");
}

function hasPreplannedHarnessSpec(value: HarnessSpec) {
  return (
    value.schemaVersion === "goat.harness.v1" &&
    value.systemPrompt.trim().length > 0 &&
    value.initialUserMessage.trim().length > 0
  );
}

function readTaskOutcome(value: unknown): {
  reportedOutcome: TaskReportedOutcome;
  outcomeComment: string;
} | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const reportedOutcome = candidate.status;
  if (reportedOutcome !== "done" && reportedOutcome !== "needs_attention") return null;
  const comment = typeof candidate.comment === "string" ? candidate.comment.trim() : "";
  return {
    reportedOutcome,
    outcomeComment: comment.slice(0, TASK_OUTCOME_COMMENT_MAX_LENGTH),
  };
}

async function recordTaskGatewayUsage(input: {
  context: TaskTurnContext;
  session: CodexChatSession;
  turn: CodexChatTurn;
  model: string;
  usage: LanguageModelUsage;
  phase: "planner" | "closer";
}) {
  const inputTokens = positiveUsage(input.usage.inputTokens);
  const outputTokens = positiveUsage(input.usage.outputTokens);
  const cost = calculateModelUsageCost({
    modelName: input.model,
    inputTokens,
    inputNoCacheTokens: positiveUsage(input.usage.inputTokenDetails?.noCacheTokens),
    inputCacheReadTokens: positiveUsage(input.usage.inputTokenDetails?.cacheReadTokens),
    inputCacheWriteTokens: positiveUsage(input.usage.inputTokenDetails?.cacheWriteTokens),
    outputTokens,
  });
  const attributes = {
    "goat.model": input.model,
    "goat.surface": "task",
    "goat.stage": input.phase,
    "goat.engine": input.session.engine,
  };
  recordModelCost({ costUsdMicros: cost.totalCostUsdMicros, attributes });
  if (inputTokens) {
    recordModelUsageTokens({ tokens: inputTokens, direction: "input", attributes });
  }
  if (outputTokens) {
    recordModelUsageTokens({ tokens: outputTokens, direction: "output", attributes });
  }
  const totalTokens = positiveUsage(input.usage.totalTokens);
  if (totalTokens) {
    recordModelUsageTokens({ tokens: totalTokens, direction: "total", attributes });
  }
  await captureProductLlmUsageRecorded({
    distinctId: input.context.task.userWorkosId,
    workspaceId: input.session.workspaceId,
    surface: "task",
    stage: input.phase,
    sessionId: input.session.chatSessionId,
    messageId: input.turn.userMessageId,
    taskId: input.context.task.id,
    turnId: input.turn.id,
    modelProvider: "vercel-ai-gateway",
    model: input.model,
    engine: input.session.engine,
    inputTokens,
    inputNoCacheTokens: positiveUsage(input.usage.inputTokenDetails?.noCacheTokens),
    inputCacheReadTokens: positiveUsage(input.usage.inputTokenDetails?.cacheReadTokens),
    inputCacheWriteTokens: positiveUsage(input.usage.inputTokenDetails?.cacheWriteTokens),
    outputTokens,
    outputTextTokens:
      positiveUsage(input.usage.outputTokenDetails?.textTokens) ||
      Math.max(0, outputTokens - positiveUsage(input.usage.outputTokenDetails?.reasoningTokens)),
    outputReasoningTokens: positiveUsage(input.usage.outputTokenDetails?.reasoningTokens),
    totalTokens: totalTokens || inputTokens + outputTokens,
    providerCostUsdMicros: cost.providerCostUsdMicros,
    platformFeeUsdMicros: cost.platformFeeUsdMicros,
    chargedCostUsdMicros: cost.totalCostUsdMicros,
    billable: cost.billable,
  });

  if (!cost.billable || !input.session.workspaceId) return;
  try {
    const debit = await recordCreditDebit({
      workspaceId: input.session.workspaceId,
      userWorkosId: input.context.task.userWorkosId,
      source: "chat_model_usage",
      idempotencyKey: `chat:${input.turn.userMessageId}:durable:${input.turn.id}:task:${input.phase}`,
      chatSessionId: input.session.chatSessionId,
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      costBasis: cost.costBasis,
      metadata: {
        engine: input.session.engine,
        taskId: input.context.task.id,
        turnId: input.turn.id,
        phase: input.phase,
      },
      db: getDb(),
    });
    if (debit.ok) {
      await captureProductModelSpendRecorded({
        userWorkosId: input.context.task.userWorkosId,
        workspaceId: input.session.workspaceId,
        billingSource: "chat_model_usage",
        surface: "task",
        model: input.model,
        stage: input.phase,
        engine: input.session.engine,
        providerCostUsdMicros: cost.providerCostUsdMicros,
        platformFeeUsdMicros: cost.platformFeeUsdMicros,
        totalCostUsdMicros: cost.totalCostUsdMicros,
        modelCostUsdMicros: cost.providerCostUsdMicros,
        ledgerId: debit.ledgerId,
        chatSessionId: input.session.chatSessionId,
        taskId: input.context.task.id,
        messageId: input.turn.userMessageId,
      });
    }
  } catch (error) {
    console.warn("opencompany Codex task Gateway credit debit failed.", {
      event: "goat.codex_task_gateway_credit_debit_failed",
      task_id: input.context.task.id,
      turn_id: input.turn.id,
      phase: input.phase,
      error,
    });
  }
}

function positiveUsage(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function taskSucceededNotification(displayId: string, result: string) {
  const taskLink = `[${displayId}](/tasks/${encodeURIComponent(displayId)})`;
  return result.trim()
    ? `Task ${taskLink} finished.\n\n${result.trim()}`
    : `Task ${taskLink} finished.`;
}

function taskFailedNotification(displayId: string, error: string) {
  const taskLink = `[${displayId}](/tasks/${encodeURIComponent(displayId)})`;
  return error.trim() ? `Task ${taskLink} failed.\n\n${error.trim()}` : `Task ${taskLink} failed.`;
}

function turnLeaseSubquery(turn: CodexChatTurn) {
  return sql`
    SELECT 1
    FROM goat.codex_chat_turns AS lease_turn
    WHERE lease_turn.id = ${turn.id}
      AND lease_turn.user_workos_id = ${turn.userWorkosId}
      AND lease_turn.codex_chat_session_id = ${turn.codexChatSessionId}
      AND lease_turn.lease_id = ${turn.leaseId}
      AND lease_turn.lease_owner = ${turn.leaseOwner}
      AND lease_turn.status = 'running'
  `;
}

function assertRowsChanged(result: unknown) {
  if (rowsFromExecute(result).length === 0) {
    throw new CodexChatLeaseLostError();
  }
}

function assertTaskMutationSucceeded(result: unknown) {
  const row = rowsFromExecute<{ outcome: "updated" | "terminal" }>(result)[0];
  if (row?.outcome === "updated") return;
  if (row?.outcome === "terminal") throw new TaskTurnTerminalError();
  throw new CodexChatLeaseLostError();
}
