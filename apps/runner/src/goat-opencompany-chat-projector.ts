import {
  captureGoatLlmUsageRecorded,
  captureGoatModelSpendRecorded,
} from "@opencompany/analytics/goat/server";
import { calculateModelUsageCost } from "@opencompany/billing";
import { recordGoatCreditDebit } from "@opencompany/db/goat-credits";
import type { GoatChatMessageDebugTrace } from "@opencompany/db/goat-schema";
import { recordGoatModelCost, recordGoatModelUsageTokens } from "@opencompany/goat-observability";
import { createLogger } from "@opencompany/observability";
import type { LanguageModelUsage } from "ai";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { GoatCodexChatLeaseLostError } from "./goat-codex-chat-errors";
import { type GoatTaskTurnCompletion, settleGoatDurableTurn } from "./goat-task-turn";
import { rowsFromExecute } from "./sql-exec";

const OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION = "opencompany.chat.debug.v1" as const;

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-opencompany-chat-projector",
});

export type GoatOpenCompanyChatUiPart = {
  type: string;
  [key: string]: unknown;
};

export type GoatOpenCompanyChatProjection = {
  parts: GoatOpenCompanyChatUiPart[];
  usage?: LanguageModelUsage;
  finishReason?: string;
};

export class GoatOpenCompanyChatInterruptedError extends Error {
  constructor() {
    super("OpenCompany chat turn was interrupted.");
    this.name = "GoatOpenCompanyChatInterruptedError";
  }
}

export type GoatOpenCompanyChatProjector = ReturnType<typeof createGoatOpenCompanyChatProjector>;

export function createGoatOpenCompanyChatProjector(input: {
  target: {
    userWorkosId: string;
    codexChatSessionId: string;
    chatSessionId: string;
    turnId: string;
    taskId?: string | null;
    userMessageId: string;
    assistantMessageId: string;
    workspaceId: string | null;
    model: string;
    leaseId: string;
    leaseOwner: string;
    turnStartedAt?: Date;
  };
}) {
  const { target } = input;

  const turnLeaseSubquery = (options: { runningOnly: boolean }) => sql`
    SELECT 1
    FROM goat.codex_chat_turns AS lease_turn
    WHERE lease_turn.id = ${target.turnId}
      AND lease_turn.user_workos_id = ${target.userWorkosId}
      AND lease_turn.codex_chat_session_id = ${target.codexChatSessionId}
      AND lease_turn.lease_id = ${target.leaseId}
      AND lease_turn.lease_owner = ${target.leaseOwner}
      ${options.runningOnly ? sql`AND lease_turn.status = 'running'` : sql``}
  `;

  const writeAssistantMessage = async (
    projection: GoatOpenCompanyChatProjection,
    options: {
      error?: string;
      aborted?: boolean;
      durationMs?: number;
    } = {},
  ) => {
    const content = projection.parts
      .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join("")
      .trim();
    const debugTrace: GoatChatMessageDebugTrace = {
      schemaVersion: OPENCOMPANY_CHAT_DEBUG_SCHEMA_VERSION,
      model: target.model,
      uiMessageParts: projection.parts,
      ...(projection.finishReason ? { finishReason: projection.finishReason } : {}),
      ...(projection.usage ? { usage: compactUsage(projection.usage) } : {}),
      ...(options.error ? { error: options.error } : {}),
      ...(options.aborted ? { aborted: true } : {}),
      ...(typeof options.durationMs === "number" ? { durationMs: options.durationMs } : {}),
    };
    assertRowsChanged(
      await getDb().execute(sql`
        UPDATE goat.chat_messages AS message
        SET content = ${content},
            debug_trace = ${JSON.stringify(debugTrace)}::jsonb,
            updated_at = ${new Date()}
        WHERE message.id = ${target.assistantMessageId}
          AND message.session_id = ${target.chatSessionId}
          AND message.role = 'assistant'
          AND EXISTS (${turnLeaseSubquery({ runningOnly: true })})
        RETURNING message.id
      `),
    );
  };

  return {
    async started() {
      const now = new Date();
      assertRowsChanged(
        await getDb().execute(sql`
          UPDATE goat.codex_chat_sessions AS session
          SET status = 'running',
              active_turn_id = ${target.turnId},
              error = NULL,
              updated_at = ${now}
          WHERE session.id = ${target.codexChatSessionId}
            AND session.user_workos_id = ${target.userWorkosId}
            AND EXISTS (${turnLeaseSubquery({ runningOnly: true })})
          RETURNING session.id
        `),
      );
    },

    project(projection: GoatOpenCompanyChatProjection) {
      return writeAssistantMessage(projection);
    },

    async recordStepUsage(input: { stepIndex: number; usage: LanguageModelUsage }) {
      await recordOpenCompanyChatModelCost({
        model: target.model,
        usage: input.usage,
        workspaceId: target.workspaceId,
        userWorkosId: target.userWorkosId,
        chatSessionId: target.chatSessionId,
        taskId: target.taskId,
        userMessageId: target.userMessageId,
        turnId: target.turnId,
        stepIndex: input.stepIndex,
      });
    },

    async checkAbort() {
      const result = await getDb().execute(sql`
        SELECT interrupt_requested_at
        FROM goat.codex_chat_turns
        WHERE id = ${target.turnId}
          AND user_workos_id = ${target.userWorkosId}
          AND codex_chat_session_id = ${target.codexChatSessionId}
          AND lease_id = ${target.leaseId}
          AND lease_owner = ${target.leaseOwner}
          AND status = 'running'
        LIMIT 1
      `);
      const row = rowsFromExecute<{ interrupt_requested_at: Date | string | null }>(result)[0];
      if (!row) throw new GoatCodexChatLeaseLostError();
      if (row.interrupt_requested_at) throw new GoatOpenCompanyChatInterruptedError();
    },

    async completed(
      projection: GoatOpenCompanyChatProjection,
      taskCompletion?: GoatTaskTurnCompletion | null,
    ) {
      const completedAt = new Date();
      const durationMs = elapsedTurnDurationMs(target.turnStartedAt, completedAt);
      await writeAssistantMessage(projection, {
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      await settleGoatDurableTurn({
        target,
        turnStatus: "completed",
        sessionStatus: "idle",
        error: null,
        completedAt,
        taskCompletion,
      });
    },

    async interrupted(
      projection: GoatOpenCompanyChatProjection,
      taskCompletion?: GoatTaskTurnCompletion | null,
    ) {
      const completedAt = new Date();
      const durationMs = elapsedTurnDurationMs(target.turnStartedAt, completedAt);
      await writeAssistantMessage(projection, {
        aborted: true,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      await settleGoatDurableTurn({
        target,
        turnStatus: "interrupted",
        sessionStatus: "interrupted",
        error: null,
        completedAt,
        taskCompletion,
      });
    },

    async failed(
      error: string,
      projection: GoatOpenCompanyChatProjection,
      taskCompletion?: GoatTaskTurnCompletion | null,
    ) {
      const completedAt = new Date();
      const durationMs = elapsedTurnDurationMs(target.turnStartedAt, completedAt);
      await writeAssistantMessage(projection, {
        error,
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      await settleGoatDurableTurn({
        target,
        turnStatus: "failed",
        sessionStatus: "idle",
        error,
        completedAt,
        taskCompletion,
      });
    },
  };
}

async function recordOpenCompanyChatModelCost(input: {
  model: string;
  usage: LanguageModelUsage;
  workspaceId: string | null;
  userWorkosId: string;
  chatSessionId: string;
  taskId?: string | null | undefined;
  userMessageId: string;
  turnId: string;
  stepIndex: number;
}) {
  const inputTokens = readUsageNumber(input.usage.inputTokens);
  const outputTokens = readUsageNumber(input.usage.outputTokens);
  const cost = calculateModelUsageCost({
    modelName: input.model,
    inputTokens,
    inputNoCacheTokens: readUsageNumber(input.usage.inputTokenDetails?.noCacheTokens),
    inputCacheReadTokens: readUsageNumber(input.usage.inputTokenDetails?.cacheReadTokens),
    inputCacheWriteTokens: readUsageNumber(input.usage.inputTokenDetails?.cacheWriteTokens),
    outputTokens,
  });
  recordGoatModelCost({
    costUsdMicros: cost.totalCostUsdMicros,
    attributes: {
      "goat.model": input.model,
      "goat.surface": "chat",
      "goat.stage": "generation",
      "goat.engine": "opencompany",
    },
  });
  recordUsageMetrics(input.usage, {
    "goat.model": input.model,
    "goat.engine": "opencompany",
  });
  await captureGoatLlmUsageRecorded({
    distinctId: input.userWorkosId,
    workspaceId: input.workspaceId,
    surface: input.taskId ? "task" : "chat",
    stage: "generation",
    sessionId: input.chatSessionId,
    messageId: input.userMessageId,
    taskId: input.taskId,
    turnId: input.turnId,
    stepIndex: input.stepIndex,
    modelProvider: "vercel-ai-gateway",
    model: input.model,
    inputTokens,
    inputNoCacheTokens: readUsageNumber(input.usage.inputTokenDetails?.noCacheTokens),
    inputCacheReadTokens: readUsageNumber(input.usage.inputTokenDetails?.cacheReadTokens),
    inputCacheWriteTokens: readUsageNumber(input.usage.inputTokenDetails?.cacheWriteTokens),
    outputTokens,
    outputTextTokens:
      readUsageNumber(input.usage.outputTokenDetails?.textTokens) ||
      Math.max(0, outputTokens - readUsageNumber(input.usage.outputTokenDetails?.reasoningTokens)),
    outputReasoningTokens: readUsageNumber(input.usage.outputTokenDetails?.reasoningTokens),
    totalTokens: readUsageNumber(input.usage.totalTokens) || inputTokens + outputTokens,
    providerCostUsdMicros: cost.providerCostUsdMicros,
    platformFeeUsdMicros: cost.platformFeeUsdMicros,
    chargedCostUsdMicros: cost.totalCostUsdMicros,
    billable: cost.billable,
  });

  if (!cost.billable || !input.workspaceId) return;
  try {
    const debit = await recordGoatCreditDebit({
      workspaceId: input.workspaceId,
      userWorkosId: input.userWorkosId,
      source: "chat_model_usage",
      idempotencyKey: `chat:${input.userMessageId}:durable:${input.turnId}:step:${input.stepIndex}`,
      chatSessionId: input.chatSessionId,
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      costBasis: cost.costBasis,
      metadata: {
        engine: "opencompany",
        turnId: input.turnId,
        stepIndex: input.stepIndex,
      },
      db: getDb(),
    });
    if (debit.ok) {
      await captureGoatModelSpendRecorded({
        userWorkosId: input.userWorkosId,
        workspaceId: input.workspaceId,
        billingSource: "chat_model_usage",
        surface: "chat",
        model: input.model,
        stage: "generation",
        engine: "opencompany",
        providerCostUsdMicros: cost.providerCostUsdMicros,
        platformFeeUsdMicros: cost.platformFeeUsdMicros,
        totalCostUsdMicros: cost.totalCostUsdMicros,
        modelCostUsdMicros: cost.providerCostUsdMicros,
        ledgerId: debit.ledgerId,
        chatSessionId: input.chatSessionId,
        messageId: input.userMessageId,
      });
    }
  } catch (error) {
    logger.warn("Durable OpenCompany chat credit debit failed", {
      event: "opencompany.goat_opencompany_chat_credit_debit_failed",
      workspace_id: input.workspaceId,
      chat_session_id: input.chatSessionId,
      turn_id: input.turnId,
      step_index: input.stepIndex,
      error,
    });
  }
}

function compactUsage(usage: LanguageModelUsage) {
  return {
    inputTokens: readUsageNumber(usage.inputTokens),
    outputTokens: readUsageNumber(usage.outputTokens),
    totalTokens: readUsageNumber(usage.totalTokens),
  };
}

function recordUsageMetrics(
  usage: LanguageModelUsage,
  attributes: Record<string, string | number>,
) {
  const inputTokens = readUsageNumber(usage.inputTokens);
  const outputTokens = readUsageNumber(usage.outputTokens);
  const totalTokens = readUsageNumber(usage.totalTokens);
  if (inputTokens) {
    recordGoatModelUsageTokens({ tokens: inputTokens, direction: "input", attributes });
  }
  if (outputTokens) {
    recordGoatModelUsageTokens({ tokens: outputTokens, direction: "output", attributes });
  }
  if (totalTokens) {
    recordGoatModelUsageTokens({ tokens: totalTokens, direction: "total", attributes });
  }
}

function readUsageNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function elapsedTurnDurationMs(startedAt: Date | undefined, completedAt: Date) {
  if (!startedAt || Number.isNaN(startedAt.getTime())) return undefined;
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function assertRowsChanged(result: unknown) {
  if (rowsFromExecute(result).length === 0) {
    throw new GoatCodexChatLeaseLostError();
  }
}
