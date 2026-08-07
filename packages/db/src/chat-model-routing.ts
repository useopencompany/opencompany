import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { getDb } from "./client";
import {
  type ChatModelRoutingErrorCategory,
  type ChatModelRoutingOutcome,
  type ChatModelRoutingReason,
  type ChatModelRoutingTier,
  chatModelRoutingAttempts,
} from "./schema";

type DbLike = any;

export type RecordChatModelRoutingAttemptInput = {
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string;
  userMessageId: string;
  classifierModel: string;
  selectedModel: AgentModelId;
  tier: ChatModelRoutingTier;
  reason: ChatModelRoutingReason;
  outcome: ChatModelRoutingOutcome;
  durationMs: number;
  errorCategory?: ChatModelRoutingErrorCategory | undefined;
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

export async function recordChatModelRoutingAttempt(
  input: RecordChatModelRoutingAttemptInput,
): Promise<void> {
  const db = input.db ?? getDb();
  await db.insert(chatModelRoutingAttempts).values({
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
