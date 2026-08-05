import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "./client";
import {
  type GoatChatModelRoutingErrorCategory,
  type GoatChatModelRoutingOutcome,
  type GoatChatModelRoutingReason,
  type GoatChatModelRoutingTier,
  goatChatModelRoutingAttempts,
} from "./goat-schema";

type DbLike = any;

export type RecordGoatChatModelRoutingAttemptInput = {
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string;
  userMessageId: string;
  classifierModel: string;
  selectedModel: AgentModelId;
  tier: GoatChatModelRoutingTier;
  reason: GoatChatModelRoutingReason;
  outcome: GoatChatModelRoutingOutcome;
  durationMs: number;
  errorCategory?: GoatChatModelRoutingErrorCategory | undefined;
  finishReason?: string | undefined;
  providerStatusCode?: number | undefined;
  providerRetryable?: boolean | undefined;
  promptLength: number;
  attachmentCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  db?: DbLike;
};

export async function recordGoatChatModelRoutingAttempt(
  input: RecordGoatChatModelRoutingAttemptInput,
): Promise<void> {
  const db = input.db ?? getDb();
  await db.insert(goatChatModelRoutingAttempts).values({
    workspaceId: input.workspaceId,
    userWorkosId: input.userWorkosId,
    chatSessionId: input.chatSessionId,
    userMessageId: input.userMessageId,
    classifierModel: input.classifierModel,
    selectedModel: input.selectedModel,
    tier: input.tier,
    reason: input.reason,
    outcome: input.outcome,
    durationMs: input.durationMs,
    errorCategory: input.errorCategory ?? null,
    finishReason: input.finishReason ?? null,
    providerStatusCode: input.providerStatusCode ?? null,
    providerRetryable: input.providerRetryable ?? null,
    promptLength: input.promptLength,
    attachmentCount: input.attachmentCount,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.totalTokens,
  });
}
