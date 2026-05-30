import {
  calculateHostedToolUsageCost,
  calculateModelUsageCost,
  recordWorkspaceUsageDebit,
} from "@opencompany/billing";
import type { FinishReason, LanguageModelResponseMetadata, LanguageModelUsage } from "ai";
import { getDb } from "./db";
import { appendRuntimeEvent } from "./events";
import type { HostedToolUsage } from "./hosted-tools";
import {
  defaultLeaseWriteStore,
  type LeaseWriteStore,
  requireLeaseWrite,
  StaleRunLeaseError,
} from "./lease-writes";
import { normalizeModelUsage } from "./usage";

export type UsageRecordResult = {
  inserted: boolean;
  charged: boolean;
  balanceUsdMicros: number | null;
};

export async function recordStepUsage(
  input: {
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
  },
  store: LeaseWriteStore = defaultLeaseWriteStore(),
) {
  const db = getDb();
  const lease = {
    sessionId: input.sessionId,
    leaseId: input.runLeaseId,
    leaseOwner: input.runLeaseOwner,
  };

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

  return db.transaction(async (tx) => {
    // Lease-guarded atomic insert: the row only lands while the lease is still ours, so
    // a stale runner cannot record usage (or bill against it below) for a session that
    // was reclaimed elsewhere. No row means the lease was lost.
    const usageRow = await store.insertModelUsage(
      {
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        runLeaseId: input.runLeaseId,
        stepIndex: input.stepIndex,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        responseId: input.response.id ?? null,
        responseModelId: input.response.modelId ?? null,
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
        providerCreatedAt: input.response.timestamp ?? null,
      },
      lease,
      tx,
    );
    if (!usageRow) {
      throw new StaleRunLeaseError();
    }
    if (!usageRow.inserted) {
      return { inserted: false, charged: false, balanceUsdMicros: null };
    }

    let balanceUsdMicros: number | null = null;
    if (cost.billable) {
      const debit = await recordWorkspaceUsageDebit({
        db: tx,
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
      if (debit.ok) balanceUsdMicros = debit.balanceUsdMicros;
    }

    const event = await appendRuntimeEvent(tx, {
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      type: "session.usage",
      payload: usagePayload,
    });
    await requireLeaseWrite(Boolean(event));
    return { inserted: true, charged: cost.billable, balanceUsdMicros } satisfies UsageRecordResult;
  });
}

export async function recordToolUsage(
  input: {
    sessionId: string;
    assistantMessageId: string;
    runLeaseId: string;
    runLeaseOwner: string;
    toolCallId: string;
    toolName: string;
    usage: HostedToolUsage;
  },
  store: LeaseWriteStore = defaultLeaseWriteStore(),
) {
  const db = getDb();
  const lease = {
    sessionId: input.sessionId,
    leaseId: input.runLeaseId,
    leaseOwner: input.runLeaseOwner,
  };
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

  return db.transaction(async (tx) => {
    // Lease-guarded atomic insert, mirroring recordStepUsage: no row means the lease was
    // lost, so we never bill a reclaimed session.
    const toolUsageRow = await store.insertToolUsage(
      {
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
      },
      lease,
      tx,
    );
    if (!toolUsageRow) {
      throw new StaleRunLeaseError();
    }
    if (!toolUsageRow.inserted) {
      return { inserted: false, charged: false, balanceUsdMicros: null };
    }

    let balanceUsdMicros: number | null = null;
    if (cost.billable) {
      const debit = await recordWorkspaceUsageDebit({
        db: tx,
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
      if (debit.ok) balanceUsdMicros = debit.balanceUsdMicros;
    }

    const event = await appendRuntimeEvent(tx, {
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      type: "session.tool_usage",
      payload: usagePayload,
    });
    await requireLeaseWrite(Boolean(event));
    return { inserted: true, charged: cost.billable, balanceUsdMicros } satisfies UsageRecordResult;
  });
}
