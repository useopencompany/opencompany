import {
  BUILTIN_USE_TOOL_NAME,
  partitionRuntimeToolNames,
  RUNTIME_TOOL_DEFINITION_BY_NAME,
  type RuntimeToolName,
  resolveAgentRuntimeConfig,
  type WorkspaceToolPolicyMap,
} from "@opencompany/agent-runtime";
import { timeAsync } from "@opencompany/observability";
import { getBraintrustAISDK } from "@opencompany/observability/braintrust";
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
import type { LoadedSession } from "./session-lifecycle";
import { normalizeReasoningSummary } from "./stream-helpers";
import { createToolSet, pickRuntimeTools } from "./tool-dispatcher";
import type { ToolStartCoordinator } from "./tool-start-coordinator";

// Default per-turn step ceiling when the env override (RUNNER_MAX_MODEL_STEPS) is absent — e.g.
// tests that build a context without going through loadEnv(). Production reads ctx.env.maxModelSteps.
export const MAX_MODEL_STEPS = 32;
const INCOMPLETE_TURN_REASON = "announced_unexecuted_next_action" as const;
const TOOL_STEP_LIMIT_REASON = "tool_step_limit_reached" as const;
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
      toolArgRepair: {
        apiKey: input.ctx.env.vercelAiGatewayApiKey,
        enabled: input.ctx.env.toolArgRepairEnabled,
      },
      toolStartCoordinator: input.toolStartCoordinator,
      policy: input.policy,
      suspendable: input.suspendable,
    }),
  );
  // Register full schemas only for the directly-callable tools (core file/shell/ask plus the
  // discovery + dispatcher tools). Deferred capability tools are reached through the single
  // `use_tool` dispatcher after the model lists them with find_tools — their schemas never enter
  // the cached tool set. MCP servers already expose their own lazy search/use meta-tools.
  const { direct, deferred } = partitionRuntimeToolNames(input.runtime.tools);
  const dispatcher = input.tools[BUILTIN_USE_TOOL_NAME];
  const selectedTools = {
    ...pickRuntimeTools(input.tools, direct),
    ...(deferred.length > 0 && dispatcher ? { [BUILTIN_USE_TOOL_NAME]: dispatcher } : {}),
    ...mcpToolSet.tools,
  };
  // Persist a debug-only snapshot of this turn's model inputs (system prompt + tool catalog)
  // so the session's "Copy Debug JSON" export can include them — they are otherwise ephemeral,
  // built here and passed straight to the model. `toolsSentToModel` is exactly the set registered
  // in the model call (`selectedTools`: direct core tools + the `use_tool` dispatcher + MCP tools),
  // so the snapshot truthfully mirrors what the model received this turn. Deferred capability tools
  // are NOT in the call — they are reachable only via `find_tools` + `use_tool` — so they are
  // listed separately under `deferredToolsNotSent` for debugging, never folded into the sent set.
  // Schemas come from the static definitions, so MCP tools appear by name only. Deferred tools were
  // NOT sent, so they are recorded as name + description only — including their full schemas here
  // would re-serialize the whole deferred catalog into every turn's snapshot for no debugging gain.
  // Best-effort: a failed write must never abort the turn, so this is deliberately NOT wrapped in
  // `requireLeaseWrite`.
  try {
    const toSentToolEntry = (name: string) => {
      const definition = RUNTIME_TOOL_DEFINITION_BY_NAME.get(name as RuntimeToolName);
      return {
        name,
        description: definition?.description ?? "",
        parameters: definition?.parameters ?? null,
      };
    };
    const toDeferredToolEntry = (name: string) => ({
      name,
      description: RUNTIME_TOOL_DEFINITION_BY_NAME.get(name as RuntimeToolName)?.description ?? "",
    });
    await appendRuntimeEventForLease({
      sessionId: input.ctx.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.ctx.leaseId,
      leaseOwner: input.ctx.leaseOwner,
      type: "debug.model_request",
      payload: {
        messageId: input.assistantMessageId,
        systemPrompt: input.system,
        toolsSentToModel: Object.keys(selectedTools).map(toSentToolEntry),
        deferredToolsNotSent: deferred.map(toDeferredToolEntry),
      },
    });
  } catch {
    // Debug-only event — swallow write failures (e.g. lost lease) so debugging never breaks a run.
  }
  // The model call is traced by Braintrust's `wrapAISDK` (via `getBraintrustAISDK`): it opens the
  // `streamText` / `doStream` LLM spans, capturing input, output, per-step tool calls, usage, and
  // derived cost, and nests them under the current per-turn root span. We keep only the Better Stack
  // timing trace here via `timeAsync`. Tradeoff: `wrapAISDK` closes its streaming span when the
  // stream drains, so on a mid-stream abort/suspend the LLM span can stay "in progress" with no
  // usage — an accepted limitation of the default integration (see docs/observability.md). When
  // Braintrust is disabled, `getBraintrustAISDK` returns the unwrapped `ai`, so this is a no-op.
  const { streamText } = getBraintrustAISDK(ai);
  try {
    return await timeAsync(
      input.ctx.trace,
      "model_stream_total",
      async () => {
        const result = streamText({
          model: gateway(input.runtime.model.name),
          system: input.system,
          messages: input.messages,
          tools: selectedTools,
          stopWhen: [
            ai.stepCountIs(input.ctx.env.maxModelSteps),
            ...(input.extraStopConditions ?? []),
          ],
          abortSignal: input.ctx.controller.signal,
          includeRawChunks: input.runtime.model.reasoningExposure === "raw",
          ...(input.runtime.model.providerOptions
            ? { providerOptions: input.runtime.model.providerOptions }
            : {}),
        });

        return collectAssistantStream({
          stream: result.fullStream,
          readFirstPart: (iterator) =>
            timeAsync(input.ctx.trace, "model_first_stream_part", () => iterator.next(), {
              model_provider: input.runtime.model.provider,
              model_name: input.runtime.model.name,
            }),
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
      },
      {
        model_provider: input.runtime.model.provider,
        model_name: input.runtime.model.name,
        assistant_message_id: input.assistantMessageId,
      },
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
  // Check the final step, not whether any step touched a tool: a turn that ends
  // on a `stop` after an earlier tool call but with no text delivered nothing to
  // the user. `lastStepEndedWithToolCalls` is the "final step produced tools"
  // signal — true only when the loop ended on tool calls (step limit / custom
  // stop), which is the legitimate tool-only case we keep valid.
  if (!streamResult.assistantContent && !streamResult.lastStepEndedWithToolCalls) {
    throw new Error("Model stream completed without text or tool calls.");
  }
}

// The model loop stopped because it hit the per-turn step ceiling while still requesting tools —
// it ran out of room before delivering a final answer. This used to throw and discard the entire
// partial turn (non-retryable), so a long coding run that needed one more step surfaced as a
// generic error with no work saved. We now treat it like `detectIncompleteTurn`: the caller
// persists the partial assistant turn, marks it continuable, and completes cleanly so the user can
// send one more message to resume (over a now-larger, env-tunable budget). Returns true only when
// the final step ended on tool calls at/above the ceiling.
export function detectToolStepLimitReached(
  streamResult: Pick<
    Awaited<ReturnType<typeof collectAssistantStream>>,
    "lastStepEndedWithToolCalls" | "stepCount"
  >,
  maxModelSteps: number,
): boolean {
  return streamResult.lastStepEndedWithToolCalls && streamResult.stepCount >= maxModelSteps;
}

export const TOOL_STEP_LIMIT_INCOMPLETE_REASON = TOOL_STEP_LIMIT_REASON;
export const TOOL_STEP_LIMIT_CONTINUE_NOTE =
  "_Reached the step limit for this turn before finishing. Send another message to continue._";

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
