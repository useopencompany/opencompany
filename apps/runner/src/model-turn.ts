import { resolveAgentRuntimeConfig, type WorkspaceToolPolicyMap } from "@opencompany/agent-runtime";
import type { LogFields } from "@opencompany/observability";
import { logBraintrustCurrentSpan, logBraintrustSpan } from "@opencompany/observability/braintrust";
import type { ModelMessage, StopCondition, ToolSet } from "ai";
import * as ai from "ai";
import {
  appendRuntimeEventForLease,
  completeAssistantMessageForLease,
  requireLeaseWrite,
} from "./lease-writes";
import { createMcpToolSet } from "./mcp-tools";
import { buildAssistantModelMessage, toPersistedModelMessage } from "./model-messages";
import { collectAssistantStream } from "./model-stream-runner";
import { observeRunStep, type RunContext } from "./run-context";
import type { RunControlCheck } from "./run-control";
import { ToolStepLimitExceededError } from "./runner-errors";
import type { LoadedSession } from "./session-lifecycle";
import {
  addAnthropicCacheControlToLastMessage,
  buildCacheableSystemPrompt,
  normalizeReasoningSummary,
} from "./stream-helpers";
import { createToolSet, pickRuntimeTools } from "./tool-dispatcher";
import type { ToolStartCoordinator } from "./tool-start-coordinator";

export const MAX_MODEL_STEPS = 16;
const INCOMPLETE_TURN_REASON = "announced_unexecuted_next_action" as const;
const INCOMPLETE_TURN_REASON_DETAIL =
  "Model stopped after announcing a next action it never took (trailing text ends mid-task).";

export async function streamAssistantResponse(input: {
  ctx: RunContext;
  runtime: ReturnType<typeof resolveAgentRuntimeConfig>;
  system: string;
  messages: ModelMessage[];
  tools: ReturnType<typeof createToolSet>;
  mcpContext: {
    internalMessages?: boolean;
    workspaceId: string;
    agentConfig: LoadedSession["agent"]["config"];
    signal: AbortSignal;
    checkAbort: RunControlCheck;
    observabilityContext?: {
      workspaceId?: string;
      userId?: string;
      agentId?: string;
      modelProvider?: string;
      modelName?: string;
    };
  };
  assistantMessageId: string;
  toolStartCoordinator: ToolStartCoordinator;
  checkAbort: RunControlCheck;
  policy: WorkspaceToolPolicyMap;
  suspendable: boolean;
  extraStopConditions?: StopCondition<ToolSet>[];
}) {
  const gateway = ai.createGateway({ apiKey: input.ctx.env.vercelAiGatewayApiKey });
  const mcpToolSet = await observeRunStep(input.ctx, "create_mcp_tool_set", () =>
    createMcpToolSet({
      sessionId: input.ctx.sessionId,
      assistantMessageId: input.assistantMessageId,
      runLeaseId: input.ctx.leaseId,
      runLeaseOwner: input.ctx.leaseOwner,
      ...input.mcpContext,
      integrationCredentialEncryptionKey: input.ctx.env.integrationCredentialEncryptionKey,
      toolStartCoordinator: input.toolStartCoordinator,
      policy: input.policy,
      suspendable: input.suspendable,
    }),
  );
  const modelSystem = buildCacheableSystemPrompt(input.system, input.runtime.model.name);
  const selectedTools = {
    ...pickRuntimeTools(input.tools, input.runtime.tools),
    ...mcpToolSet.tools,
  };
  // Instrument the model call as an `llm` span manually rather than via Braintrust's `wrapAISDK`.
  // wrapAISDK closes the streaming span only when its patched result stream drains to completion
  // (there is no error/cancel handler on that path), so any abort, tool/stream error, or early
  // exit while we consume `result.fullStream` ourselves leaves the span stuck "in progress" with
  // no usage logged. `observeRunStep` -> `traceBraintrustStep` always calls `span.end()` in a
  // finally, so the span closes deterministically and we log usage/cost from data we collect.
  const modelInput = [
    ...(modelSystem ? [{ role: "system", content: modelSystem }] : []),
    ...input.messages,
  ];
  try {
    const streamStartedAt = Date.now();
    let firstStreamPartAt: number | undefined;
    return await observeRunStep(
      input.ctx,
      "model_stream_total",
      async (span) => {
        const result = ai.streamText({
          model: gateway(input.runtime.model.name),
          system: modelSystem,
          messages: input.messages,
          tools: selectedTools,
          stopWhen: [ai.stepCountIs(MAX_MODEL_STEPS), ...(input.extraStopConditions ?? [])],
          abortSignal: input.ctx.controller.signal,
          includeRawChunks: input.runtime.model.reasoningExposure === "raw",
          prepareStep: ({ messages }) => ({
            messages: addAnthropicCacheControlToLastMessage(messages, input.runtime.model.name),
          }),
          ...(input.runtime.model.providerOptions
            ? { providerOptions: input.runtime.model.providerOptions }
            : {}),
        });

        const collected = await collectAssistantStream({
          stream: result.fullStream,
          readFirstPart: async (iterator) => {
            return observeRunStep(input.ctx, "model_first_stream_part", () => iterator.next(), {
              model_provider: input.runtime.model.provider,
              model_name: input.runtime.model.name,
            });
          },
          onFirstOutputPart: () => {
            firstStreamPartAt ??= Date.now();
          },
          sessionId: input.ctx.sessionId,
          assistantMessageId: input.assistantMessageId,
          runLeaseId: input.ctx.leaseId,
          runLeaseOwner: input.ctx.leaseOwner,
          modelProvider: input.runtime.model.provider,
          modelName: input.runtime.model.name,
          reasoningExposure: input.runtime.model.reasoningExposure,
          signal: input.ctx.controller.signal,
          checkAbort: input.checkAbort,
          toolStartCoordinator: input.toolStartCoordinator,
          policy: input.policy,
          suspendable: input.suspendable,
        });
        // Log on the explicit span object (not `currentSpan()`): the AI SDK stream consumption can
        // run outside this span's async-context, which would silently drop a `currentSpan()` log
        // to a no-op span — leaving the span with no output/usage and stuck "in progress".
        logBraintrustSpan(span, {
          output: collected.reasoningSummary
            ? {
                role: "assistant",
                content: collected.assistantContent,
                reasoning: collected.reasoningSummary,
              }
            : collected.reasoningContent
              ? {
                  role: "assistant",
                  content: collected.assistantContent,
                  reasoning: collected.reasoningContent,
                }
              : { role: "assistant", content: collected.assistantContent },
          metrics: modelStreamMetrics(collected.modelSteps, streamStartedAt, firstStreamPartAt),
          metadata: {
            // Braintrust derives estimated cost from `metadata.model` + token metrics.
            model: input.runtime.model.name,
            assistant_message_id: input.assistantMessageId,
            model_provider: input.runtime.model.provider,
            model_name: input.runtime.model.name,
          },
        });
        return collected;
      },
      {
        model_provider: input.runtime.model.provider,
        model_name: input.runtime.model.name,
        assistant_message_id: input.assistantMessageId,
      },
      { type: "llm", input: modelInput },
    );
  } finally {
    await mcpToolSet.close();
  }
}

export async function persistAssistantCompletion(input: {
  sessionId: string;
  assistantMessageId: string;
  leaseId: string;
  leaseOwner: string;
  assistantContent: string;
  assistantReplayParts: Awaited<ReturnType<typeof collectAssistantStream>>["assistantReplayParts"];
  reasoningSummary: Awaited<ReturnType<typeof collectAssistantStream>>["reasoningSummary"];
  reasoningContent: Awaited<ReturnType<typeof collectAssistantStream>>["reasoningContent"];
  internal: boolean;
}) {
  const persistedAssistantModelMessage = toPersistedModelMessage(
    buildAssistantModelMessage({
      content: input.assistantContent,
      parts: input.assistantReplayParts,
    }),
  );
  await requireLeaseWrite(
    completeAssistantMessageForLease({
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
      content: input.assistantContent,
      modelMessage: persistedAssistantModelMessage,
    }),
  );
  const normalizedReasoningSummary = normalizeReasoningSummary(input.reasoningSummary);
  const normalizedReasoningContent = normalizeReasoningSummary(input.reasoningContent);
  logBraintrustCurrentSpan({
    output: {
      content: input.assistantContent,
      replayParts: input.assistantReplayParts,
      ...(normalizedReasoningSummary ? { reasoningSummary: normalizedReasoningSummary } : {}),
      ...(normalizedReasoningContent ? { reasoningContent: normalizedReasoningContent } : {}),
    },
    metadata: {
      assistant_message_id: input.assistantMessageId,
      internal: input.internal,
    },
  });
  if (normalizedReasoningSummary) {
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.leaseId,
        leaseOwner: input.leaseOwner,
        type: "message.reasoning_summary",
        payload: { messageId: input.assistantMessageId, summary: normalizedReasoningSummary },
      }),
    );
  }
  if (normalizedReasoningContent) {
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.leaseId,
        leaseOwner: input.leaseOwner,
        type: "message.reasoning_content",
        payload: {
          messageId: input.assistantMessageId,
          text: normalizedReasoningContent,
          format: "raw",
        },
      }),
    );
  }
  await requireLeaseWrite(
    appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.leaseId,
      leaseOwner: input.leaseOwner,
      type: "message.completed",
      payload: {
        messageId: input.assistantMessageId,
        ...(input.internal ? { internal: true } : {}),
      },
    }),
  );
}

export function assertTurnComplete(
  streamResult: Pick<
    Awaited<ReturnType<typeof collectAssistantStream>>,
    "assistantContent" | "assistantReplayParts" | "lastStepEndedWithToolCalls" | "stepCount"
  >,
) {
  if (!streamResult.assistantContent && streamResult.assistantReplayParts.length === 0) {
    throw new Error("Model stream completed without text or tool calls.");
  }

  if (streamResult.lastStepEndedWithToolCalls && streamResult.stepCount >= MAX_MODEL_STEPS) {
    throw new ToolStepLimitExceededError();
  }
}

// A healthy completed turn ends with `finishReason === "stop"` after the model
// has actually delivered its answer. A turn that *abandons* the task also ends
// with `stop` — the model emits a step like "Now let me check the files…:" and
// then produces no tool call, so the AI SDK ends the loop and the run is
// recorded as a clean `completed`. `stop` alone therefore cannot tell the two
// apart (see docs/agent-turn-vocabulary.md and
// .context/issue-premature-turn-completion.md).
//
// This detects the abandoned case conservatively, favoring precision so a
// genuine completion is never flagged. We only flag when ALL hold:
//   1. the turn ended with a plain `stop` (not tool-calls / length / error),
//   2. the turn actually drove at least one tool — i.e. it was doing work, the
//      exact shape of the production failure — so a plain conversational reply
//      is never flagged, and
//   3. the trailing narration announces an unexecuted next action: after
//      trimming, the final assistant text ends with a colon. A real final
//      answer essentially never ends on a colon; an announced-but-skipped tool
//      step almost always does ("Let me check the files changed:").
export function detectIncompleteTurn(
  streamResult: Pick<
    Awaited<ReturnType<typeof collectAssistantStream>>,
    "assistantContent" | "assistantReplayParts" | "lastFinishReason" | "lastStepEndedWithToolCalls"
  >,
): { reason: typeof INCOMPLETE_TURN_REASON; reasonDetail: string } | null {
  if (streamResult.lastFinishReason !== "stop") return null;
  if (streamResult.lastStepEndedWithToolCalls) return null;

  const usedTools = streamResult.assistantReplayParts.some((part) => part.type === "tool-call");
  if (!usedTools) return null;

  const trailingText = streamResult.assistantContent.trimEnd();
  if (!trailingText.endsWith(":")) return null;

  return {
    reason: INCOMPLETE_TURN_REASON,
    reasonDetail: INCOMPLETE_TURN_REASON_DETAIL,
  };
}

function modelStreamMetrics(
  modelSteps: Awaited<ReturnType<typeof collectAssistantStream>>["modelSteps"],
  streamStartedAt: number,
  firstStreamPartAt: number | undefined,
): LogFields {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;

  for (const step of modelSteps) {
    const usage = isRecord(step.usage) ? step.usage : {};
    inputTokens += readMetricNumber(usage.inputTokens) ?? readMetricNumber(usage.promptTokens) ?? 0;
    outputTokens +=
      readMetricNumber(usage.outputTokens) ?? readMetricNumber(usage.completionTokens) ?? 0;
    totalTokens += readMetricNumber(usage.totalTokens) ?? 0;
    cachedTokens += readMetricNumber(usage.cachedInputTokens) ?? 0;
    reasoningTokens += readMetricNumber(usage.reasoningTokens) ?? 0;
  }

  if (totalTokens === 0) totalTokens = inputTokens + outputTokens;

  return {
    ...(firstStreamPartAt
      ? { time_to_first_token: (firstStreamPartAt - streamStartedAt) / 1000 }
      : {}),
    ...(totalTokens ? { tokens: totalTokens } : {}),
    ...(inputTokens ? { prompt_tokens: inputTokens } : {}),
    ...(outputTokens ? { completion_tokens: outputTokens } : {}),
    ...(cachedTokens ? { prompt_cached_tokens: cachedTokens } : {}),
    ...(reasoningTokens ? { completion_reasoning_tokens: reasoningTokens } : {}),
    steps: modelSteps.length,
  };
}

function readMetricNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
