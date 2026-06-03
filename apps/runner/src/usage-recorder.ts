import {
  calculateHostedToolUsageCost,
  calculateModelUsageCost,
  calculateSandboxUsageCost,
  recordWorkspaceUsageDebit,
} from "@opencompany/billing";
import type { FinishReason, LanguageModelResponseMetadata, LanguageModelUsage } from "ai";
import { getDb } from "./db";
import type { HostedToolUsage } from "./hosted-tools";
import {
  appendRuntimeEventForLease,
  defaultLeaseWriteStore,
  type LeaseWriteStore,
  requireLeaseWrite,
  StaleRunLeaseError,
} from "./lease-writes";
import { normalizeModelUsage } from "./usage";

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
  );
  if (!usageRow) {
    throw new StaleRunLeaseError();
  }

  if (cost.billable) {
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
  );
  if (!toolUsageRow) {
    throw new StaleRunLeaseError();
  }

  if (cost.billable) {
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

export async function recordSandboxUsage(
  input: {
    sessionId: string;
    assistantMessageId: string;
    runLeaseId: string;
    runLeaseOwner: string;
    sandboxId: string;
    template: string | null;
    vcpu: number | null;
    ramMib: number | null;
    startedAt: Date;
    endedAt: Date;
    activeMs: number;
  },
  store: LeaseWriteStore = defaultLeaseWriteStore(),
) {
  const db = getDb();
  const lease = {
    sessionId: input.sessionId,
    leaseId: input.runLeaseId,
    leaseOwner: input.runLeaseOwner,
  };
  const cost = calculateSandboxUsageCost({
    template: input.template,
    vcpu: input.vcpu ?? 0,
    ramMiB: input.ramMib ?? 0,
    activeMs: input.activeMs,
  });

  const usagePayload = {
    messageId: input.assistantMessageId,
    runLeaseId: input.runLeaseId,
    sandboxId: input.sandboxId,
    template: input.template,
    vcpu: input.vcpu,
    ramMib: input.ramMib,
    activeMs: input.activeMs,
    providerCostUsdMicros: cost.providerCostUsdMicros,
    platformFeeUsdMicros: cost.platformFeeUsdMicros,
    chargedCostUsdMicros: cost.totalCostUsdMicros,
  };

  // Lease-guarded atomic insert, mirroring recordToolUsage: no row means the lease was
  // lost, so we never bill a reclaimed session.
  const sandboxUsageRow = await store.insertSandboxUsage(
    {
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      runLeaseId: input.runLeaseId,
      sandboxId: input.sandboxId,
      template: input.template,
      vcpu: input.vcpu,
      ramMib: input.ramMib,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      activeMs: input.activeMs,
      costUsdMicros: cost.providerCostUsdMicros,
      rawMetrics: {},
    },
    lease,
  );
  if (!sandboxUsageRow) {
    throw new StaleRunLeaseError();
  }

  if (cost.billable) {
    await recordWorkspaceUsageDebit({
      db,
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      sandboxUsageId: sandboxUsageRow.id,
      source: "sandbox_usage",
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      costBasis: cost.costBasis,
      metadata: {
        runLeaseId: input.runLeaseId,
        sandboxId: input.sandboxId,
        template: input.template,
        activeMs: input.activeMs,
      },
    });
  }

  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      type: "session.sandbox_usage",
      payload: usagePayload,
    }),
  );
}
