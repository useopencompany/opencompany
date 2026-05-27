import {
  calculateHostedToolUsageCost,
  calculateModelUsageCost,
  recordWorkspaceUsageDebit,
} from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import { agentSessionToolUsage, agentSessionUsage } from "@opencompany/db/schema";
import type { FinishReason, LanguageModelResponseMetadata, LanguageModelUsage } from "ai";
import type { HostedToolUsage } from "./hosted-tools";
import { appendRuntimeEventForLease, isRunLeaseCurrent, requireLeaseWrite } from "./lease-writes";
import { normalizeModelUsage } from "./usage";

export async function recordStepUsage(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  stepIndex: number;
  modelProvider: string;
  modelName: string;
  response: LanguageModelResponseMetadata;
  usage: LanguageModelUsage;
  finishReason: FinishReason;
  rawFinishReason: string | undefined;
}) {
  const db = getDb();
  await requireLeaseWrite(
    isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
  );

  const usage = normalizeModelUsage(input.usage);
  const cost = calculateModelUsageCost({
    modelName: input.modelName,
    inputTokens: usage.inputTokens,
    inputNoCacheTokens: usage.inputNoCacheTokens,
    inputCacheReadTokens: usage.inputCacheReadTokens,
    inputCacheWriteTokens: usage.inputCacheWriteTokens,
    outputTokens: usage.outputTokens,
  });
  const usagePayload = {
    messageId: input.assistantMessageId,
    runLeaseId: input.runLeaseId,
    stepIndex: input.stepIndex,
    modelProvider: input.modelProvider,
    modelName: input.modelName,
    responseModelId: input.response.modelId,
    inputTokens: usage.inputTokens,
    inputNoCacheTokens: usage.inputNoCacheTokens,
    inputCacheReadTokens: usage.inputCacheReadTokens,
    inputCacheWriteTokens: usage.inputCacheWriteTokens,
    outputTokens: usage.outputTokens,
    outputTextTokens: usage.outputTextTokens,
    outputReasoningTokens: usage.outputReasoningTokens,
    totalTokens: usage.totalTokens,
    providerCostUsdMicros: cost.providerCostUsdMicros,
    platformFeeUsdMicros: cost.platformFeeUsdMicros,
    chargedCostUsdMicros: cost.totalCostUsdMicros,
    finishReason: input.finishReason,
    ...(input.rawFinishReason ? { rawFinishReason: input.rawFinishReason } : {}),
  };

  const [usageRow] = await db
    .insert(agentSessionUsage)
    .values({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      runLeaseId: input.runLeaseId,
      stepIndex: input.stepIndex,
      modelProvider: input.modelProvider,
      modelName: input.modelName,
      responseId: input.response.id,
      responseModelId: input.response.modelId,
      finishReason: input.finishReason,
      rawFinishReason: input.rawFinishReason ?? null,
      inputTokens: usage.inputTokens,
      inputNoCacheTokens: usage.inputNoCacheTokens,
      inputCacheReadTokens: usage.inputCacheReadTokens,
      inputCacheWriteTokens: usage.inputCacheWriteTokens,
      outputTokens: usage.outputTokens,
      outputTextTokens: usage.outputTextTokens,
      outputReasoningTokens: usage.outputReasoningTokens,
      totalTokens: usage.totalTokens,
      rawUsage: usage.rawUsage,
      providerCreatedAt: input.response.timestamp,
    })
    .returning({ id: agentSessionUsage.id });

  if (usageRow && cost.billable) {
    await recordWorkspaceUsageDebit({
      db,
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      modelUsageId: usageRow.id,
      source: "model_usage",
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      costBasis: cost.costBasis,
      metadata: {
        runLeaseId: input.runLeaseId,
        stepIndex: input.stepIndex,
        responseId: input.response.id,
        responseModelId: input.response.modelId,
      },
    });
  }

  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      type: "session.usage",
      payload: usagePayload,
    }),
  );
}

export async function recordToolUsage(input: {
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  toolCallId: string;
  toolName: string;
  usage: HostedToolUsage;
}) {
  const db = getDb();
  await requireLeaseWrite(
    isRunLeaseCurrent(input.sessionId, input.runLeaseId, input.runLeaseOwner),
  );
  const cost = calculateHostedToolUsageCost({
    provider: input.usage.provider,
    operation: input.usage.operation,
    providerCostUsdMicros: input.usage.costUsdMicros,
  });

  const usagePayload = {
    messageId: input.assistantMessageId,
    runLeaseId: input.runLeaseId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    provider: input.usage.provider,
    operation: input.usage.operation,
    ...(input.usage.providerRequestId ? { providerRequestId: input.usage.providerRequestId } : {}),
    costUsdMicros: input.usage.costUsdMicros,
    providerCostUsdMicros: cost.providerCostUsdMicros,
    platformFeeUsdMicros: cost.platformFeeUsdMicros,
    chargedCostUsdMicros: cost.totalCostUsdMicros,
  };

  const [toolUsageRow] = await db
    .insert(agentSessionToolUsage)
    .values({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      runLeaseId: input.runLeaseId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      provider: input.usage.provider,
      operation: input.usage.operation,
      providerRequestId: input.usage.providerRequestId ?? null,
      costUsdMicros: input.usage.costUsdMicros,
      rawUsage: input.usage.rawUsage,
    })
    .returning({ id: agentSessionToolUsage.id });

  if (toolUsageRow && cost.billable) {
    await recordWorkspaceUsageDebit({
      db,
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      toolUsageId: toolUsageRow.id,
      source: "tool_usage",
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      costBasis: cost.costBasis,
      metadata: {
        runLeaseId: input.runLeaseId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        providerRequestId: input.usage.providerRequestId,
      },
    });
  }

  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      type: "session.tool_usage",
      payload: usagePayload,
    }),
  );
}
