import { randomUUID } from "node:crypto";
import {
  codexCliModelNameForModelId,
  GOAT_CODEX_HOST_TOOL_CONTRACT_VERSION,
} from "@opencompany/agent-runtime";
import { calculateModelUsageCost } from "@opencompany/billing";
import { recordGoatCreditDebit } from "@opencompany/db/goat-credits";
import {
  type GoatCodexChatSession,
  type GoatCodexChatSessionStatus,
  type GoatCodexChatTurn,
  type GoatHarnessSpec,
  type GoatTask,
  type GoatTaskReportedOutcome,
} from "@opencompany/db/goat-schema";
import {
  UPDATE_TASK_STATUS_TOOL_DESCRIPTION,
  UPDATE_TASK_STATUS_TOOL_INPUT_JSON_SCHEMA,
} from "@opencompany/goat-agent/chat-agent";
import {
  createGoatGatewayAttribution,
  goatGatewayProviderOptions,
  recordGoatModelCost,
  recordGoatModelUsageTokens,
} from "@opencompany/goat-observability";
import * as ai from "ai";
import { createGateway, jsonSchema, type LanguageModelUsage } from "ai";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { createGoatBrainMarkdownReportForTask } from "./goat-brain";
import { GoatCodexChatLeaseLostError, GoatTaskTurnCanceledError } from "./goat-codex-chat-errors";
import { getGoatAvailableGitHubRepositoryNamesForRunner } from "./goat-harness-planner";
import { normalizeGoatTaskToolNames } from "./goat-task-tool-names";
import { rowsFromExecute } from "./sql-exec";

const TASK_OUTCOME_COMMENT_MAX_LENGTH = 200;
const GOAT_TASK_CLOSER_MODEL = "openai/gpt-5.4-mini";

export type GoatTaskTurnContext = {
  task: GoatTask;
  harnessSpec: GoatHarnessSpec;
};

export type GoatTaskTurnCompletion = {
  taskId: string;
  taskDisplayId: string;
  taskName: string;
  harnessSpec: GoatHarnessSpec;
  result: string;
  reportedOutcome: GoatTaskReportedOutcome | null;
  outcomeComment: string | null;
  nextTurn: GoatTaskNextTurn | null;
};

type GoatTaskNextTurn = {
  id: string;
  userMessageId: string;
  assistantMessageId: string;
  prompt: string;
  harnessSpec: GoatHarnessSpec;
  engine: GoatHarnessSpec["engine"];
  chatModel: string;
  runtimeModel: string;
  hostToolContractVersion: string | null;
  settings: Record<string, unknown>;
  assistantDebugTrace: Record<string, unknown>;
};

export async function markGoatTaskTurnRunning(input: {
  context: GoatTaskTurnContext;
  turn: GoatCodexChatTurn;
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
    SELECT 'canceled'::text AS outcome
    FROM goat.tasks AS task
    WHERE task.id = ${input.context.task.id}
      AND task.session_id = ${input.turn.chatSessionId}
      AND task.user_workos_id = ${input.turn.userWorkosId}
      AND task.status = 'canceled'
      AND EXISTS (${turnLeaseSubquery(input.turn)})
    LIMIT 1
  `);
  assertTaskMutationSucceeded(result);
}

export async function prepareGoatCodexTaskTurn(input: {
  context: GoatTaskTurnContext;
  turn: GoatCodexChatTurn;
  session: GoatCodexChatSession;
  env: RunnerEnv;
  signal: AbortSignal;
}): Promise<GoatTaskTurnContext> {
  await markGoatTaskTurnRunning({ context: input.context, turn: input.turn, stage: "planning" });
  const task = input.context.task;
  const preplanned = hasPreplannedHarnessSpec(task.harnessSpec);
  if (preplanned) {
    await markGoatTaskTurnRunning({ context: input.context, turn: input.turn });
    return input.context;
  }

  const githubRepositories = task.harnessSpec.tools.some((tool) => tool.startsWith("github_"))
    ? await getGoatAvailableGitHubRepositoryNamesForRunner(task.userWorkosId)
    : [];
  const { GOAT_PLANNER_MODEL, planGoatHarnessForTask } = await import("./goat-harness");
  const planned = await planGoatHarnessForTask({
    prompt: task.prompt,
    model: task.model,
    requestedEngine: "codex",
    availableTools: normalizeGoatTaskToolNames(task.harnessSpec.tools),
    githubRepositories,
    gatewayApiKey: input.env.vercelAiGatewayApiKey,
    userWorkosId: task.userWorkosId,
    taskId: task.id,
    signal: input.signal,
  });
  if (planned.usage) {
    await recordGoatCodexTaskGatewayUsage({
      context: input.context,
      session: input.session,
      turn: input.turn,
      model: GOAT_PLANNER_MODEL,
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
          harness_spec = ${JSON.stringify(harnessSpec)}::jsonb,
          debug_trace = ${JSON.stringify(planned.debugTrace)}::jsonb,
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
    SELECT 'canceled'::text AS outcome
    FROM goat.tasks AS task
    WHERE task.id = ${task.id}
      AND task.session_id = ${input.turn.chatSessionId}
      AND task.user_workos_id = ${input.turn.userWorkosId}
      AND task.status = 'canceled'
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

export async function closeGoatCodexTaskTurn(input: {
  context: GoatTaskTurnContext;
  finalContent: string;
  env: RunnerEnv;
  session: GoatCodexChatSession;
  turn: GoatCodexChatTurn;
  signal: AbortSignal;
}): Promise<{
  reportedOutcome: GoatTaskReportedOutcome;
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
      model: gateway(GOAT_TASK_CLOSER_MODEL),
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
            status: GoatTaskReportedOutcome;
            comment: string;
          }>(UPDATE_TASK_STATUS_TOOL_INPUT_JSON_SCHEMA),
        }),
      },
      toolChoice: "required",
      abortSignal: input.signal,
      providerOptions: goatGatewayProviderOptions(
        createGoatGatewayAttribution({
          userWorkosId: input.context.task.userWorkosId,
          feature: "task",
          taskId: input.context.task.id,
        }),
      ),
    });
    const call = result.toolCalls.find((toolCall) => toolCall.toolName === "update_task_status");
    await recordGoatCodexTaskGatewayUsage({
      context: input.context,
      session: input.session,
      turn: input.turn,
      model: GOAT_TASK_CLOSER_MODEL,
      usage: result.usage,
      phase: "closer",
    });
    return readTaskOutcome(call?.input);
  } catch (error) {
    if (input.signal.aborted) {
      throw input.signal.reason instanceof Error ? input.signal.reason : error;
    }
    console.warn("Goat Codex task closer failed; the task completes without a reported outcome.", {
      event: "goat.codex_task_closer_failed",
      task_id: input.context.task.id,
      error,
    });
    return null;
  }
}

export async function finalizeGoatTaskResult(input: {
  context: GoatTaskTurnContext;
  assistantContent: string;
  turnId?: string | undefined;
}) {
  const content = input.assistantContent.trim();
  if (input.context.harnessSpec.resultMode !== "brain_markdown_report") return content;
  const artifact = await createGoatBrainMarkdownReportForTask({
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

export function buildGoatTaskTurnCompletion(input: {
  context: GoatTaskTurnContext;
  result: string;
  reportedOutcome?: GoatTaskReportedOutcome | null | undefined;
  outcomeComment?: string | null | undefined;
}): GoatTaskTurnCompletion {
  const workflow = input.context.harnessSpec.workflow;
  const reportedOutcome = input.reportedOutcome ?? null;
  let outcomeComment =
    input.outcomeComment?.trim().slice(0, TASK_OUTCOME_COMMENT_MAX_LENGTH) || null;
  let harnessSpec = input.context.harnessSpec;
  let nextTurn: GoatTaskNextTurn | null = null;

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
    if (reportedOutcome !== "needs_attention" && nextStep) {
      const nextHarnessSpec: GoatHarnessSpec = {
        ...harnessSpec,
        engine: nextStep.engine,
        model: nextStep.model,
        systemPrompt: nextStep.systemPrompt,
        systemBlocks: nextStep.systemBlocks,
        workflow: {
          ...harnessSpec.workflow!,
          currentStepIndex: currentStepIndex + 1,
        },
      };
      nextTurn = createNextTaskTurn({
        harnessSpec: nextHarnessSpec,
        prompt: goatWorkflowStepHandoffContent({
          stepIndex: currentStepIndex + 1,
          stepCount: workflow.steps.length,
          title: nextStep.title,
          engine: nextStep.engine,
          previousResult: input.result,
        }),
      });
      harnessSpec = nextHarnessSpec;
    }
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

export function buildGoatTaskTerminalProjection(
  context: GoatTaskTurnContext,
): GoatTaskTurnCompletion {
  return {
    taskId: context.task.id,
    taskDisplayId: context.task.displayId,
    taskName: context.task.name,
    harnessSpec: context.harnessSpec,
    result: "",
    reportedOutcome: null,
    outcomeComment: null,
    nextTurn: null,
  };
}

export async function settleGoatDurableTurn(input: {
  target: {
    userWorkosId: string;
    codexChatSessionId: string;
    chatSessionId: string;
    turnId: string;
    leaseId: string;
    leaseOwner: string;
  };
  turnStatus: "completed" | "failed" | "interrupted";
  sessionStatus: GoatCodexChatSessionStatus;
  error: string | null;
  completedAt: Date;
  taskCompletion?: GoatTaskTurnCompletion | null | undefined;
}) {
  const { target } = input;
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
  const notificationContent = completion
    ? input.turnStatus === "completed"
      ? taskSucceededNotification(completion.taskDisplayId, completion.result)
      : input.turnStatus === "failed"
        ? taskFailedNotification(completion.taskDisplayId, input.error ?? "")
        : null
    : null;

  const result = await getDb().execute(sql`
    WITH settled_turn AS (
      UPDATE goat.codex_chat_turns AS turn
      SET status = ${input.turnStatus},
          error = ${input.error},
          completed_at = ${input.completedAt},
          updated_at = ${input.completedAt}
      WHERE turn.id = ${target.turnId}
        AND turn.user_workos_id = ${target.userWorkosId}
        AND turn.lease_id = ${target.leaseId}
        AND turn.lease_owner = ${target.leaseOwner}
        AND turn.status = 'running'
      RETURNING turn.id
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
            ELSE ${input.error}
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
            ${completion ? JSON.stringify(completion.harnessSpec) : null}::jsonb,
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
    next_user_message AS (
      INSERT INTO goat.chat_messages (
        id, session_id, role, content, created_at, updated_at
      )
      SELECT
        ${next?.userMessageId ?? null},
        task.session_id,
        'user',
        ${next?.prompt ?? null},
        ${input.completedAt},
        ${input.completedAt}
      FROM projected_task AS task
      WHERE ${Boolean(next)}
      RETURNING id
    ),
    next_assistant_message AS (
      INSERT INTO goat.chat_messages (
        id, session_id, role, content, debug_trace, created_at, updated_at
      )
      SELECT
        ${next?.assistantMessageId ?? null},
        task.session_id,
        'assistant',
        '',
        ${next ? JSON.stringify(next.assistantDebugTrace) : null}::jsonb,
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
        ${next ? JSON.stringify(next.settings) : null}::jsonb,
        ${new Date(input.completedAt.getTime() + 2)},
        ${new Date(input.completedAt.getTime() + 2)}
      FROM projected_task AS task
      WHERE ${Boolean(next)}
        AND EXISTS (SELECT 1 FROM next_user_message)
        AND EXISTS (SELECT 1 FROM next_assistant_message)
      RETURNING id
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
            WHEN EXISTS (SELECT 1 FROM next_queued_turn) THEN 'queued'
            ELSE ${input.sessionStatus}
          END,
          engine = COALESCE(${next?.engine ?? null}, runtime.engine),
          model = COALESCE(${next?.runtimeModel ?? null}, runtime.model),
          host_tool_contract_version = CASE
            WHEN ${Boolean(next)} THEN ${next?.hostToolContractVersion ?? null}
            ELSE runtime.host_tool_contract_version
          END,
          error = ${input.error},
          updated_at = ${input.completedAt}
      WHERE runtime.id = ${target.codexChatSessionId}
        AND runtime.user_workos_id = ${target.userWorkosId}
        AND (runtime.active_turn_id IS NULL OR runtime.active_turn_id = ${target.turnId})
        AND EXISTS (SELECT 1 FROM settled_turn)
      RETURNING runtime.id, runtime.chat_session_id
    ),
    updated_task_chat AS (
      UPDATE goat.chat_sessions AS chat
      SET engine = COALESCE(${next?.engine ?? null}, chat.engine),
          model = COALESCE(${next?.chatModel ?? null}, chat.model),
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
      SET updated_at = ${input.completedAt}
      FROM inserted_notification AS notification
      WHERE chat.id = notification.session_id
      RETURNING chat.id
    )
    SELECT runtime.id
    FROM updated_runtime AS runtime
    WHERE EXISTS (SELECT 1 FROM updated_task_chat)
  `);
  assertRowsChanged(result);
}

function createNextTaskTurn(input: {
  harnessSpec: GoatHarnessSpec;
  prompt: string;
}): GoatTaskNextTurn {
  const runtimeModel =
    input.harnessSpec.engine === "codex"
      ? codexCliModelNameForModelId(input.harnessSpec.model)
      : input.harnessSpec.model;
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
    harnessSpec: input.harnessSpec,
    engine: input.harnessSpec.engine,
    chatModel: input.harnessSpec.model,
    runtimeModel,
    hostToolContractVersion:
      input.harnessSpec.engine === "codex" ? GOAT_CODEX_HOST_TOOL_CONTRACT_VERSION : null,
    settings: {
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

function goatWorkflowStepHandoffContent(input: {
  stepIndex: number;
  stepCount: number;
  title: string;
  engine: GoatHarnessSpec["engine"];
  previousResult: string;
}) {
  const heading = `Step ${input.stepIndex + 1}/${input.stepCount} — ${input.title.trim() || "Untitled step"}`;
  if (input.engine !== "codex" || !input.previousResult.trim()) return heading;
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

function hasPreplannedHarnessSpec(value: GoatHarnessSpec) {
  return (
    value.schemaVersion === "goat.harness.v1" &&
    value.systemPrompt.trim().length > 0 &&
    value.initialUserMessage.trim().length > 0
  );
}

function readTaskOutcome(value: unknown): {
  reportedOutcome: GoatTaskReportedOutcome;
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

async function recordGoatCodexTaskGatewayUsage(input: {
  context: GoatTaskTurnContext;
  session: GoatCodexChatSession;
  turn: GoatCodexChatTurn;
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
    "goat.engine": "codex",
  };
  recordGoatModelCost({ costUsdMicros: cost.totalCostUsdMicros, attributes });
  if (inputTokens) {
    recordGoatModelUsageTokens({ tokens: inputTokens, direction: "input", attributes });
  }
  if (outputTokens) {
    recordGoatModelUsageTokens({ tokens: outputTokens, direction: "output", attributes });
  }
  const totalTokens = positiveUsage(input.usage.totalTokens);
  if (totalTokens) {
    recordGoatModelUsageTokens({ tokens: totalTokens, direction: "total", attributes });
  }

  if (!cost.billable || !input.session.workspaceId) return;
  try {
    await recordGoatCreditDebit({
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
        engine: "codex",
        taskId: input.context.task.id,
        turnId: input.turn.id,
        phase: input.phase,
      },
      db: getDb(),
    });
  } catch (error) {
    console.warn("Goat Codex task Gateway credit debit failed.", {
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

function turnLeaseSubquery(turn: GoatCodexChatTurn) {
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
    throw new GoatCodexChatLeaseLostError();
  }
}

function assertTaskMutationSucceeded(result: unknown) {
  const row = rowsFromExecute<{ outcome: "updated" | "canceled" }>(result)[0];
  if (row?.outcome === "updated") return;
  if (row?.outcome === "canceled") throw new GoatTaskTurnCanceledError();
  throw new GoatCodexChatLeaseLostError();
}
