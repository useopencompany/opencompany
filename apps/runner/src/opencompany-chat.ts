import {
  CHAT_MAX_STEPS,
  CHAT_MAX_STEPS_WITH_SANDBOX,
  createProductChatToolContext,
  prepareProductChatStep,
  TASK_SYSTEM_BLOCK,
  TASK_UNTRUSTED_CONTENT_SAFETY_BLOCK,
} from "@opencompany/agent/chat-agent";
import type {
  ChatUiMessage,
  StoredChatMessage,
  WebFetchToolOutput,
  WebSearchToolOutput,
} from "@opencompany/agent/chat-ui";
import {
  replaceChatUiMessageText,
  textFromChatUiMessage,
  toChatUiMessage,
} from "@opencompany/agent/chat-ui";
import { executeChatExaFetch } from "@opencompany/agent/chat-web-fetch";
import { executeChatExaSearch } from "@opencompany/agent/chat-web-search";
import { resolveImessageProvider } from "@opencompany/agent/imessage/provider";
import { createSendUserMessageRunner } from "@opencompany/agent/imessage/send-user-message";
import { resolveProductLanguageModel } from "@opencompany/agent/language-model";
import { createProductChatSystemPrompt } from "@opencompany/agent/prompts";
import {
  AGENT_MODEL_CATALOG,
  CHAT_ARTIFACT_DATA_PART_TYPE,
  GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
  modelSupportsAttachments,
  parsePublishedChatArtifact,
} from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import type { ChatPresentationPublisher } from "@opencompany/chat-presentation";
import { ensureMonthlyIncludedUsage } from "@opencompany/db/billing";
import { hasPositiveCreditBalance } from "@opencompany/db/credits";
import { resolveImessageDelivery } from "@opencompany/db/imessage";
import {
  type ChatMessageAttachment,
  type CodexChatSession,
  type CodexChatTurn,
  chatMessages,
} from "@opencompany/db/product-schema";
import {
  DEFAULT_BRAIN_SLUG,
  getBrainAccess,
  getWorkspaceRole,
  isLegacyBrainEnabledForWorkspace,
  listAccessibleBrains,
} from "@opencompany/db/workspaces";
import { createLogger } from "@opencompany/observability";
import { getBraintrustAISDK } from "@opencompany/observability/braintrust";
import {
  createGatewayAttribution,
  type GatewayAttribution,
  gatewayProviderOptions,
} from "@opencompany/telemetry";
import { flushLatitude } from "@opencompany/telemetry/latitude";
import * as ai from "ai";
import { convertToModelMessages, type LanguageModelUsage, parsePartialJson, stepCountIs } from "ai";
import { asc, eq } from "drizzle-orm";
import { downloadBlobBytes } from "./attachment-hydration";
import { runTaskBrainRead } from "./codex-brain-tool";
import {
  CodexChatHandoffError,
  CodexChatLeaseLostError,
  TaskTurnTerminalError,
} from "./codex-chat-errors";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { createActionDispatcher } from "./opencompany-action-gateway";
import { createBrainCaptureRunner } from "./opencompany-brain-capture";
import {
  createProductChatProjector,
  ProductChatInterruptedError,
  type ProductChatProjection,
  type ProductChatProjector,
  type ProductChatUiPart,
} from "./opencompany-chat-projector";
import { attachHostSkillsToPrompt, loadHostTools } from "./opencompany-host-tools";
import {
  buildTaskTerminalProjection,
  buildTaskTurnCompletion,
  closeTaskTurn,
  markTaskTurnRunning,
  type TaskTurnContext,
} from "./task-turn";
import { loadWorkflowTaskSkillBundles } from "./workflow-skill-bundles";

// Durable chat_messages write cadence. Live text streams via the separate 50ms presentation-delta
// path below, so this interval only bounds how often the Electric read-model row is rewritten.
const ASSISTANT_PARTS_FLUSH_INTERVAL_MS = 2000;
const PRESENTATION_DELTA_FLUSH_INTERVAL_MS = 50;
const INTERRUPT_POLL_INTERVAL_MS = 500;

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-opencompany-chat",
});

export function productChatGatewayProviderOptions(attribution: GatewayAttribution) {
  return gatewayProviderOptions(attribution, GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS);
}

function isTextExtractableAttachment(attachment: Pick<ChatMessageAttachment, "kind">) {
  return (
    attachment.kind === "docx" ||
    attachment.kind === "xlsx" ||
    attachment.kind === "srt" ||
    attachment.kind === "csv" ||
    attachment.kind === "tsv" ||
    attachment.kind === "json" ||
    attachment.kind === "text"
  );
}

export async function runProductChatTurn(input: {
  turn: CodexChatTurn;
  session: CodexChatSession;
  env: RunnerEnv;
  taskContext?: TaskTurnContext | undefined;
  canonicalAttemptId?: string;
  presentationPublisher?: ChatPresentationPublisher;
  shouldAbort?: () => Error | null;
}): Promise<"settled" | "handed_off"> {
  const { turn, session, env } = input;
  const leaseId = turn.leaseId;
  const leaseOwner = turn.leaseOwner;
  if (!leaseId || !leaseOwner) {
    throw new Error(`Claimed opencompany chat turn ${turn.id} is missing its lease.`);
  }
  if (session.engine !== "opencompany") {
    throw new Error(`Session ${session.id} is not an opencompany-engine session.`);
  }

  const feature = input.taskContext ? "task" : "chat";
  const modelResolution = session.workspaceId
    ? await resolveProductLanguageModel({
        workspaceId: session.workspaceId,
        modelId: session.model,
        feature,
        gatewayApiKey: env.vercelAiGatewayApiKey,
        db: getDb(),
      })
    : null;
  const subscriptionCovered = modelResolution?.billing === "subscription_covered";

  const projector = createProductChatProjector({
    target: {
      userWorkosId: turn.userWorkosId,
      codexChatSessionId: session.id,
      chatSessionId: session.chatSessionId,
      turnId: turn.id,
      taskId: input.taskContext?.task.id ?? null,
      userMessageId: turn.userMessageId,
      assistantMessageId: turn.assistantMessageId,
      workspaceId: session.workspaceId,
      model: session.model,
      billing: subscriptionCovered ? "subscription_covered" : "metered_gateway",
      provider: subscriptionCovered ? "codex-backend" : "gateway",
      leaseId,
      leaseOwner,
      ...(input.canonicalAttemptId ? { canonicalAttemptId: input.canonicalAttemptId } : {}),
      turnStartedAt:
        turn.runAfter && turn.runAfter > turn.createdAt ? turn.runAfter : turn.createdAt,
    },
  });
  let projection = turn.settings.approvalContinuation
    ? await loadProductChatProjection(turn.assistantMessageId)
    : { parts: [] };
  await projector.started();

  if (turn.interruptRequestedAt) {
    await projector.interrupted(
      projection,
      input.taskContext ? buildTaskTerminalProjection(input.taskContext) : null,
    );
    return "settled";
  }

  if (session.workspaceId && !subscriptionCovered) {
    if (!(await hasHostedTurnCredits(session.workspaceId))) {
      const message =
        "This workspace is out of credits. Hobby usage refreshes on the first of the month; Pro admins can add credits in Settings → Billing.";
      projection = { parts: [{ type: "text", text: message }] };
      await projector.failed(
        message,
        projection,
        input.taskContext ? buildTaskTerminalProjection(input.taskContext) : null,
      );
      return "settled";
    }
  }

  const generationController = new AbortController();
  const abortWatcher = createProductAbortWatcher({
    signalController: generationController,
    projector,
    ...(input.shouldAbort ? { shouldAbort: input.shouldAbort } : {}),
  });
  let runtimeCleanup: (() => Promise<void>) | null = null;

  try {
    await abortWatcher.checkNow();
    if (input.taskContext) {
      await markTaskTurnRunning({ context: input.taskContext, turn });
    }
    const runtime = await resolveProductChatRuntime({
      turn,
      session,
      env,
      signal: generationController.signal,
      taskContext: input.taskContext,
    });
    runtimeCleanup = runtime.cleanup;
    throwIfAborted(generationController.signal);
    const messages = await loadProductChatModelMessages({
      chatSessionId: session.chatSessionId,
      currentUserMessageId: turn.userMessageId,
      modelId: runtime.model,
      blobToken: env.blobReadWriteToken,
      includeCurrentAssistantMessage: turn.settings.approvalContinuation === true,
      activeSkills: runtime.activeSkills,
    });
    throwIfAborted(generationController.signal);
    if (!modelResolution) {
      throw new Error("Durable opencompany chat session is missing its workspace.");
    }
    const { streamText } = getBraintrustAISDK(ai);
    const attribution = createGatewayAttribution({
      userWorkosId: turn.userWorkosId,
      feature,
      chatSessionId: session.chatSessionId,
      ...(input.taskContext ? { taskId: input.taskContext.task.id } : {}),
      ...(runtime.brain ? { brainRef: runtime.brain.id } : {}),
    });
    const stream = streamText({
      model: modelResolution.model,
      system: runtime.system,
      messages,
      tools: runtime.toolContext.tools,
      stopWhen: stepCountIs(runtime.maxSteps),
      prepareStep: ({ stepNumber }) =>
        prepareProductChatStep({
          stepNumber,
          maxSteps: runtime.maxSteps,
        }),
      ...(runtime.toolContext.repairToolCall
        ? { experimental_repairToolCall: runtime.toolContext.repairToolCall }
        : {}),
      abortSignal: generationController.signal,
      providerOptions:
        modelResolution.providerOptions ?? productChatGatewayProviderOptions(attribution),
    });

    projection = await consumeProductChatStream({
      fullStream: stream.fullStream,
      signal: generationController.signal,
      sink: {
        project: async (nextProjection) => {
          projection = nextProjection;
          await projector.project(nextProjection);
        },
        recordStepUsage: (usage) => projector.recordStepUsage(usage),
        ...(input.presentationPublisher
          ? {
              present: (delta: { startOffset: number; endOffset: number; delta: string }) => {
                input.presentationPublisher?.publish({
                  runId: turn.id,
                  attemptNumber: turn.attempts,
                  schemaVersion: 1,
                  occurredAt: new Date().toISOString(),
                  type: "message.presentation_delta",
                  payload: {
                    messageId: turn.assistantMessageId,
                    ...delta,
                  },
                });
              },
            }
          : {}),
      },
      initialProjection: projection,
    });
    await abortWatcher.checkNow();
    const pendingApprovals = approvalDraftsFromProjection(projection);
    if (pendingApprovals.length > 0) {
      await abortWatcher.stop();
      await projector.paused(projection, pendingApprovals);
      return "settled";
    }
    projection = withCompletedResponseFallback(projection);
    const taskResult = projectionText(projection);
    const taskOutcome = input.taskContext
      ? await closeTaskTurn({
          context: input.taskContext,
          finalContent: taskResult,
          env,
          session,
          turn,
          signal: generationController.signal,
        })
      : null;
    await abortWatcher.checkNow();
    await abortWatcher.stop();
    await projector.completed(
      projection,
      input.taskContext
        ? buildTaskTurnCompletion({
            context: input.taskContext,
            result: taskResult,
            reportedOutcome: taskOutcome?.reportedOutcome,
            outcomeComment: taskOutcome?.outcomeComment,
          })
        : null,
    );
    return "settled";
  } catch (error) {
    const effectiveError = recognizedAbortError(error)
      ? error
      : recognizedAbortError(generationController.signal.reason)
        ? generationController.signal.reason
        : (input.shouldAbort?.() ?? error);
    projection = {
      ...projection,
      parts: finalizeStreamingParts(projection.parts),
    };
    if (effectiveError instanceof CodexChatHandoffError) {
      return "handed_off";
    }
    if (
      effectiveError instanceof ProductChatInterruptedError ||
      effectiveError instanceof TaskTurnTerminalError
    ) {
      await projector.interrupted(
        projection,
        input.taskContext ? buildTaskTerminalProjection(input.taskContext) : null,
      );
      return "settled";
    }
    if (effectiveError instanceof CodexChatLeaseLostError) {
      throw effectiveError;
    }

    const message = errorMessage(effectiveError);
    logger.warn("Durable opencompany chat turn execution failed", {
      event: "opencompany.goat_opencompany_chat_turn_execution_failed",
      turn_id: turn.id,
      codex_chat_session_id: session.id,
      attempt: turn.attempts,
      error_name: effectiveError instanceof Error ? effectiveError.name : typeof effectiveError,
      error: message,
    });
    await projector.failed(
      message,
      projection,
      input.taskContext ? buildTaskTerminalProjection(input.taskContext) : null,
    );
    return "settled";
  } finally {
    await abortWatcher.stop();
    await runtimeCleanup?.().catch((error) => {
      logger.warn("Durable opencompany Chat host cleanup failed", {
        event: "opencompany.goat_opencompany_chat_host_cleanup_failed",
        turn_id: turn.id,
        error: errorMessage(error),
      });
    });
    await flushLatitude();
  }
}

export async function hasHostedTurnCredits(workspaceId: string, db = getDb()) {
  await ensureMonthlyIncludedUsage(workspaceId, { db });
  return hasPositiveCreditBalance(workspaceId, db);
}

export async function consumeProductChatStream(input: {
  fullStream: AsyncIterable<unknown>;
  signal: AbortSignal;
  sink: Pick<ProductChatProjector, "project" | "recordStepUsage"> & {
    present?: (input: { startOffset: number; endOffset: number; delta: string }) => void;
  };
  flushIntervalMs?: number;
  presentationFlushIntervalMs?: number;
  now?: () => number;
  initialProjection?: ProductChatProjection;
}): Promise<ProductChatProjection> {
  const parts: ProductChatUiPart[] = cloneParts(input.initialProjection?.parts ?? []);
  const textPartIndexes = new Map<string, number>();
  const reasoningPartIndexes = new Map<string, number>();
  const toolPartIndexes = new Map<string, number>();
  const toolInputBuffers = new Map<string, string>();
  const flushIntervalMs = input.flushIntervalMs ?? ASSISTANT_PARTS_FLUSH_INTERVAL_MS;
  const presentationFlushIntervalMs =
    input.presentationFlushIntervalMs ?? PRESENTATION_DELTA_FLUSH_INTERVAL_MS;
  const now = input.now ?? Date.now;
  let lastFlushAt = now() - flushIntervalMs;
  let lastPresentationAt = now() - presentationFlushIntervalMs;
  let presentedContent = projectionText(input.initialProjection ?? { parts: [] });
  let dirty = false;
  let latestUsage: LanguageModelUsage | undefined;
  let finishReason: string | undefined;
  let stepIndex = 0;

  for (const [index, part] of parts.entries()) {
    if (typeof part.toolCallId === "string") toolPartIndexes.set(part.toolCallId, index);
  }

  const projection = (): ProductChatProjection => ({
    parts: cloneParts(parts),
    ...(latestUsage ? { usage: latestUsage } : {}),
    ...(finishReason ? { finishReason } : {}),
  });
  const flush = async (force = false) => {
    if (!dirty) return;
    const currentTime = now();
    if (!force && currentTime - lastFlushAt < flushIntervalMs) return;
    lastFlushAt = currentTime;
    dirty = false;
    await input.sink.project(projection());
  };
  const present = (force = false) => {
    if (!input.sink.present) return;
    const content = projectionText(projection());
    if (content === presentedContent) return;
    if (!content.startsWith(presentedContent)) {
      presentedContent = content;
      return;
    }
    const currentTime = now();
    if (!force && currentTime - lastPresentationAt < presentationFlushIntervalMs) return;
    const startOffset = presentedContent.length;
    const delta = content.slice(startOffset);
    if (!delta) return;
    presentedContent = content;
    lastPresentationAt = currentTime;
    input.sink.present({ startOffset, endOffset: content.length, delta });
  };
  const appendPart = (part: ProductChatUiPart) => {
    parts.push(part);
    dirty = true;
    return parts.length - 1;
  };
  const replacePart = (index: number, part: ProductChatUiPart) => {
    parts[index] = part;
    dirty = true;
  };

  try {
    for await (const value of input.fullStream) {
      throwIfAborted(input.signal);
      if (!isRecord(value) || typeof value.type !== "string") continue;
      const part = value;

      if (part.type === "text-start") {
        const id = readString(part.id);
        if (id) {
          textPartIndexes.set(
            id,
            appendPart({
              type: "text",
              text: "",
              state: "streaming",
              ...providerMetadataFrom(part),
            }),
          );
        }
      } else if (part.type === "text-delta") {
        const id = readString(part.id);
        const text = readStringAllowEmpty(part.text);
        if (id && text !== null) {
          const index =
            textPartIndexes.get(id) ??
            appendPart({
              type: "text",
              text: "",
              state: "streaming",
              ...providerMetadataFrom(part),
            });
          textPartIndexes.set(id, index);
          const existing = partAt(parts, index);
          replacePart(index, {
            ...existing,
            text: `${typeof existing?.text === "string" ? existing.text : ""}${text}`,
            state: "streaming",
            ...providerMetadataFrom(part),
          });
          present(false);
          await flush(false);
        }
      } else if (part.type === "text-end") {
        const index = textPartIndexes.get(readString(part.id) ?? "");
        if (index !== undefined) {
          replacePart(index, {
            ...partAt(parts, index),
            state: "done",
            ...providerMetadataFrom(part),
          });
          present(true);
        }
      } else if (part.type === "reasoning-start") {
        const id = readString(part.id);
        if (id) {
          reasoningPartIndexes.set(
            id,
            appendPart({
              type: "reasoning",
              text: "",
              state: "streaming",
              ...providerMetadataFrom(part),
            }),
          );
        }
      } else if (part.type === "reasoning-delta") {
        const id = readString(part.id);
        const text = readStringAllowEmpty(part.text);
        if (id && text !== null) {
          const index =
            reasoningPartIndexes.get(id) ??
            appendPart({
              type: "reasoning",
              text: "",
              state: "streaming",
              ...providerMetadataFrom(part),
            });
          reasoningPartIndexes.set(id, index);
          const existing = partAt(parts, index);
          replacePart(index, {
            ...existing,
            text: `${typeof existing?.text === "string" ? existing.text : ""}${text}`,
            state: "streaming",
            ...providerMetadataFrom(part),
          });
          await flush(false);
        }
      } else if (part.type === "reasoning-end") {
        const index = reasoningPartIndexes.get(readString(part.id) ?? "");
        if (index !== undefined) {
          replacePart(index, {
            ...partAt(parts, index),
            state: "done",
            ...providerMetadataFrom(part),
          });
        }
      } else if (part.type === "tool-input-start") {
        const toolCallId = readString(part.id);
        const toolName = readString(part.toolName);
        if (toolCallId && toolName) {
          toolInputBuffers.set(toolCallId, "");
          toolPartIndexes.set(
            toolCallId,
            appendPart(
              productToolPart({
                part,
                toolCallId,
                toolName,
                state: "input-streaming",
              }),
            ),
          );
          await flush(true);
        }
      } else if (part.type === "tool-input-delta") {
        const toolCallId = readString(part.id);
        const delta = readStringAllowEmpty(part.delta);
        if (toolCallId && delta !== null) {
          const buffer = `${toolInputBuffers.get(toolCallId) ?? ""}${delta}`;
          toolInputBuffers.set(toolCallId, buffer);
          const index = toolPartIndexes.get(toolCallId);
          if (index !== undefined) {
            const parsed = await parsePartialJson(buffer);
            replacePart(index, {
              ...partAt(parts, index),
              ...(parsed.value !== undefined ? { input: parsed.value } : {}),
            });
          }
        }
      } else if (part.type === "tool-call") {
        const toolCallId = readString(part.toolCallId);
        const toolName = readString(part.toolName);
        if (toolCallId && toolName) {
          const nextPart = productToolPart({
            part,
            toolCallId,
            toolName,
            state: "input-available",
            input: part.input,
          });
          const index = toolPartIndexes.get(toolCallId);
          if (index === undefined) {
            toolPartIndexes.set(toolCallId, appendPart(nextPart));
          } else {
            replacePart(index, { ...parts[index], ...nextPart });
          }
          await flush(true);
        }
      } else if (part.type === "tool-approval-request") {
        // AI SDK 6 nests the tool call inside `toolCall`; see ToolApprovalRequestOutput.
        // A missing or unmatched toolCallId must fail the turn, not be silently ignored,
        // or the run settles "completed" while the model waits on an approval no one saw.
        const approvalId = readString(part.approvalId);
        const toolCall = isRecord(part.toolCall) ? part.toolCall : null;
        const toolCallId = toolCall ? readString(toolCall.toolCallId) : null;
        const index = toolCallId ? toolPartIndexes.get(toolCallId) : undefined;
        if (!approvalId || !toolCallId || index === undefined) {
          throw new Error(
            "Received a tool-approval-request event that could not be correlated to a " +
              `tracked tool call (approvalId=${approvalId ?? "missing"}, ` +
              `toolCallId=${toolCallId ?? "missing"}).`,
          );
        }
        replacePart(index, {
          ...partAt(parts, index),
          state: "approval-requested",
          approval: { id: approvalId },
        });
        await flush(true);
      } else if (part.type === "tool-result") {
        const toolCallId = readString(part.toolCallId);
        const toolName = readString(part.toolName);
        if (toolCallId && toolName) {
          const nextPart = productToolPart({
            part,
            toolCallId,
            toolName,
            state: "output-available",
            input: part.input,
            output: part.output,
          });
          const index = toolPartIndexes.get(toolCallId);
          if (index === undefined) {
            toolPartIndexes.set(toolCallId, appendPart(nextPart));
          } else {
            replacePart(index, { ...parts[index], ...nextPart });
          }
          const artifact = publishedArtifactFromActionResult(toolName, part.output);
          if (
            artifact &&
            !parts.some(
              (candidate) =>
                candidate.type === CHAT_ARTIFACT_DATA_PART_TYPE &&
                isRecord(candidate.data) &&
                candidate.data.artifactVersionId === artifact.artifactVersionId,
            )
          ) {
            appendPart({ type: CHAT_ARTIFACT_DATA_PART_TYPE, data: artifact });
          }
          await flush(true);
        }
      } else if (part.type === "tool-error") {
        const toolCallId = readString(part.toolCallId);
        const toolName = readString(part.toolName);
        if (toolCallId && toolName) {
          const nextPart = productToolPart({
            part,
            toolCallId,
            toolName,
            state: "output-error",
            input: part.input,
            errorText: errorMessage(part.error),
          });
          const index = toolPartIndexes.get(toolCallId);
          if (index === undefined) {
            toolPartIndexes.set(toolCallId, appendPart(nextPart));
          } else {
            replacePart(index, { ...parts[index], ...nextPart });
          }
          await flush(true);
        }
      } else if (part.type === "start-step") {
        appendPart({ type: "step-start" });
      } else if (part.type === "finish-step") {
        if (isLanguageModelUsage(part.usage)) {
          latestUsage = part.usage;
          await input.sink.recordStepUsage({ stepIndex, usage: part.usage });
        }
        stepIndex += 1;
        await flush(true);
      } else if (part.type === "finish") {
        finishReason = readString(part.finishReason) ?? undefined;
        if (isLanguageModelUsage(part.totalUsage)) {
          latestUsage = part.totalUsage;
        }
      } else if (part.type === "abort") {
        throw abortReason(input.signal, readString(part.reason) ?? "Model stream was aborted.");
      } else if (part.type === "error") {
        throw part.error instanceof Error
          ? part.error
          : new Error(readString(part.error) ?? "opencompany model stream failed.");
      }
    }
  } catch (error) {
    const abort = recognizedAbortError(error)
      ? error
      : recognizedAbortError(input.signal.reason)
        ? input.signal.reason
        : null;
    // Preserve the most recent throttled text/reasoning before interruption or a model failure.
    // Once the lease is lost, the database projector must not write another byte.
    if (!(abort instanceof CodexChatLeaseLostError)) {
      const finalizedParts = finalizeStreamingParts(parts);
      parts.splice(0, parts.length, ...finalizedParts);
      dirty = true;
      present(true);
      await flush(true);
    }
    throw error;
  }

  throwIfAborted(input.signal);
  const finalizedParts = finalizeStreamingParts(parts);
  parts.splice(0, parts.length, ...finalizedParts);
  dirty = true;
  present(true);
  await flush(true);
  return projection();
}

function publishedArtifactFromActionResult(toolName: string, output: unknown) {
  if (toolName !== "use_action" || !isRecord(output) || output.ok !== true) return null;
  const result = isRecord(output.result) ? output.result : null;
  return result ? parsePublishedChatArtifact({ ok: true, artifact: result.artifact }) : null;
}

export async function opencompanyModelMessagesFromStored(
  storedMessages: readonly StoredChatMessage[],
  currentUserMessageId: string,
  options?: {
    modelId?: string | undefined;
    blobToken?: string | undefined;
    includeCurrentAssistantMessage?: boolean;
    activeSkills?: Array<{
      id: string;
      name: string;
      description: string;
      instructions: string;
    }>;
  },
) {
  const currentIndex = storedMessages.findIndex(
    (message) => message.id === currentUserMessageId && message.role === "user",
  );
  if (currentIndex < 0) {
    throw new Error(`opencompany chat user message ${currentUserMessageId} was not found.`);
  }
  const nextMessage = storedMessages[currentIndex + 1];
  const replayMessages = storedMessages.slice(
    0,
    currentIndex +
      (options?.includeCurrentAssistantMessage && nextMessage?.role === "assistant" ? 2 : 1),
  );
  const uiMessages = replayMessages.map((message) => {
    // Server-side replay retains only the provider metadata needed for encrypted
    // Responses reasoning continuity. Browser-facing serialization still strips it.
    const uiMessage = toChatUiMessage(message, { preserveProviderMetadata: true });
    return message.id === currentUserMessageId && options?.activeSkills?.length
      ? replaceChatUiMessageText(
          uiMessage,
          attachHostSkillsToPrompt(textFromChatUiMessage(uiMessage), options.activeSkills),
        )
      : uiMessage;
  });
  return convertToModelMessages(
    await hydrateProductAttachmentParts({
      uiMessages,
      storedMessages: replayMessages,
      modelId: options?.modelId,
      blobToken: options?.blobToken,
    }),
  );
}

async function loadProductChatModelMessages(input: {
  chatSessionId: string;
  currentUserMessageId: string;
  modelId: string;
  blobToken: string | undefined;
  includeCurrentAssistantMessage: boolean;
  activeSkills?: Array<{
    id: string;
    name: string;
    description: string;
    instructions: string;
  }>;
}) {
  const rows = await getDb()
    .select({
      id: chatMessages.id,
      sessionId: chatMessages.sessionId,
      role: chatMessages.role,
      content: chatMessages.content,
      taskId: chatMessages.taskId,
      debugTrace: chatMessages.debugTrace,
      attachments: chatMessages.attachments,
      attachmentTexts: chatMessages.attachmentTexts,
      createdAt: chatMessages.createdAt,
      updatedAt: chatMessages.updatedAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, input.chatSessionId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
  const storedMessages: StoredChatMessage[] = rows.map((row) => ({
    ...row,
    taskDisplayId: null,
    taskName: null,
    taskPrompt: null,
    taskStatus: null,
  }));
  return opencompanyModelMessagesFromStored(storedMessages, input.currentUserMessageId, {
    modelId: input.modelId,
    blobToken: input.blobToken,
    includeCurrentAssistantMessage: input.includeCurrentAssistantMessage,
    ...(input.activeSkills ? { activeSkills: input.activeSkills } : {}),
  });
}

async function loadProductChatProjection(
  assistantMessageId: string,
): Promise<ProductChatProjection> {
  const [message] = await getDb()
    .select({ debugTrace: chatMessages.debugTrace })
    .from(chatMessages)
    .where(eq(chatMessages.id, assistantMessageId))
    .limit(1);
  const parts = message?.debugTrace?.uiMessageParts;
  return {
    parts: Array.isArray(parts) ? (structuredClone(parts) as ProductChatUiPart[]) : [],
  };
}

async function hydrateProductAttachmentParts(input: {
  uiMessages: ChatUiMessage[];
  storedMessages: readonly Pick<
    StoredChatMessage,
    "id" | "role" | "attachments" | "attachmentTexts"
  >[];
  modelId: string | undefined;
  blobToken: string | undefined;
}): Promise<ChatUiMessage[]> {
  const attachmentsByMessageId = new Map<
    string,
    {
      attachments: ChatMessageAttachment[];
      attachmentTexts: Record<string, string> | null;
    }
  >();
  const seenAttachmentIds = new Set<string>();
  for (const message of input.storedMessages) {
    if (message.role !== "user" || !message.attachments?.length) continue;
    const attachments = message.attachments.filter((attachment) => {
      if (seenAttachmentIds.has(attachment.id)) return false;
      seenAttachmentIds.add(attachment.id);
      return true;
    });
    if (attachments.length > 0) {
      attachmentsByMessageId.set(message.id, {
        attachments,
        attachmentTexts: message.attachmentTexts,
      });
    }
  }
  if (attachmentsByMessageId.size === 0) return input.uiMessages;

  const capabilities = input.modelId
    ? modelSupportsAttachments(input.modelId)
    : { images: false, pdf: false };
  return Promise.all(
    input.uiMessages.map(async (message) => {
      const stored = message.role === "user" ? attachmentsByMessageId.get(message.id) : undefined;
      if (!stored?.attachments?.length) return message;

      const parts: ChatUiMessage["parts"] = [...message.parts];
      for (const attachment of stored.attachments) {
        parts.push(
          ...(await productAttachmentToParts({
            attachment,
            attachmentTexts: stored.attachmentTexts,
            capabilities,
            blobToken: input.blobToken,
          })),
        );
      }
      return { ...message, parts };
    }),
  );
}

async function productAttachmentToParts(input: {
  attachment: ChatMessageAttachment;
  attachmentTexts: Record<string, string> | null;
  capabilities: { images: boolean; pdf: boolean };
  blobToken: string | undefined;
}): Promise<ChatUiMessage["parts"]> {
  const { attachment } = input;
  const label = `[Attached file "${attachment.filename}" (${attachment.kind}) - attachment id: ${attachment.id}]`;

  if (isTextExtractableAttachment(attachment)) {
    const text = input.attachmentTexts?.[attachment.id];
    return [
      {
        type: "text",
        text: text
          ? `${label}\n\n${text}`
          : `${label} - no text could be extracted from this file.`,
      },
    ];
  }

  const supported =
    attachment.kind === "image" ? input.capabilities.images : input.capabilities.pdf;
  if (!supported) {
    return [{ type: "text", text: `${label} - not viewable with the current model.` }];
  }

  try {
    const bytes = await downloadBlobBytes(attachment.blobUrl, input.blobToken);
    return [
      { type: "text", text: label },
      {
        type: "file",
        mediaType: attachment.mediaType,
        filename: attachment.filename,
        url: `data:${attachment.mediaType};base64,${bytes.toString("base64")}`,
      },
    ];
  } catch (error) {
    logger.warn("Durable opencompany chat attachment hydration failed", {
      event: "opencompany.goat_opencompany_chat_attachment_hydration_failed",
      kind: attachment.kind,
      error: error instanceof Error ? error.name : "unknown",
    });
    return [{ type: "text", text: `${label} - the file could not be loaded.` }];
  }
}

async function resolveProductChatRuntime(input: {
  turn: CodexChatTurn;
  session: CodexChatSession;
  env: RunnerEnv;
  signal: AbortSignal;
  taskContext?: TaskTurnContext | undefined;
}) {
  const { turn, session, env, signal, taskContext } = input;
  const model = session.model as AgentModelId;
  if (!AGENT_MODEL_CATALOG.some((candidate) => candidate.id === model)) {
    throw new Error(`Unsupported opencompany chat model: ${session.model}.`);
  }
  if (!session.workspaceId) {
    throw new Error("Durable opencompany chat session is missing its workspace.");
  }
  const workspaceId = session.workspaceId;
  const workspaceRole = await getWorkspaceRole(
    { userWorkosId: turn.userWorkosId, workspaceId },
    { db: getDb() },
  );
  if (!workspaceRole) {
    throw new Error("You no longer have access to this chat's workspace.");
  }
  const legacyBrainEnabled = await isLegacyBrainEnabledForWorkspace(workspaceId, { db: getDb() });

  let brain = null;
  if (legacyBrainEnabled && session.brainRef) {
    const access = await getBrainAccess(
      { userWorkosId: turn.userWorkosId, brainRef: session.brainRef },
      { db: getDb() },
    );
    if (!access || access.brain.workspaceId !== workspaceId) {
      throw new Error("You no longer have access to this chat's Brain.");
    }
    brain = access.brain;
  } else if (legacyBrainEnabled) {
    const brains = await listAccessibleBrains(
      { userWorkosId: turn.userWorkosId, workspaceId },
      { db: getDb() },
    );
    brain = brains.find((candidate) => candidate.slug === DEFAULT_BRAIN_SLUG) ?? brains[0] ?? null;
  }

  const actionDispatcher = await createActionDispatcher({
    sessionId: session.id,
    turnId: turn.id,
    signal,
    approvalContinuation: Boolean(turn.settings.approvalContinuation),
  });
  const hostTools = taskContext
    ? null
    : await loadHostTools({
        sessionId: session.id,
        turnId: turn.id,
        env,
        signal,
        mentionedSkillIds: (turn.settings.mentions ?? []).map((mention) => mention.id),
        approvalContinuation: Boolean(turn.settings.approvalContinuation),
      });
  if (!taskContext && (!actionDispatcher || !hostTools)) {
    throw new Error("The durable Chat host gateways are not configured.");
  }

  const currentDate = new Date();
  const brainCapture =
    brain && !taskContext
      ? createBrainCaptureRunner({
          sessionId: session.id,
          turnId: turn.id,
          signal,
        })
      : null;
  const exaApiKey = env.exaApiKey?.trim();
  const imessageDelivery =
    resolveImessageProvider() !== null
      ? await resolveImessageDelivery(turn.userWorkosId, getDb()).catch(() => null)
      : null;
  const toolContext = createProductChatToolContext({
    model,
    latestUserMessage: turn.prompt,
    ...(imessageDelivery
      ? {
          sendUserMessage: createSendUserMessageRunner({
            userWorkosId: turn.userWorkosId,
            phoneE164: imessageDelivery.phoneE164,
            source: "task",
            chatSessionId: session.chatSessionId,
            turnId: turn.id,
            signal,
          }),
        }
      : {}),
    ...(brain
      ? {
          runBrainCli: (toolInput) =>
            runTaskBrainRead({
              brainRef: brain.id,
              userWorkosId: turn.userWorkosId,
              chatSessionId: session.chatSessionId,
              gatewayApiKey: env.vercelAiGatewayApiKey,
              toolInput,
              db: getDb(),
            }),
        }
      : {}),
    ...(brainCapture ? { saveToBrain: brainCapture } : {}),
    ...(hostTools?.startTask ? { startTask: hostTools.startTask } : {}),
    ...(hostTools?.scheduleTask ? { scheduleTask: hostTools.scheduleTask } : {}),
    ...(hostTools?.editTaskSchedule ? { editTaskSchedule: hostTools.editTaskSchedule } : {}),
    ...(hostTools?.deleteTaskSchedule ? { deleteTaskSchedule: hostTools.deleteTaskSchedule } : {}),
    ...(hostTools?.createWorkspaceSkill
      ? { createWorkspaceSkill: hostTools.createWorkspaceSkill }
      : {}),
    ...(hostTools?.runWiki ? { runWiki: hostTools.runWiki as never } : {}),
    ...(hostTools?.browserTools ? { browserTools: hostTools.browserTools } : {}),
    ...(hostTools?.browserProfiles ? { browserProfiles: hostTools.browserProfiles } : {}),
    ...(hostTools?.skills ? { skills: hostTools.skills } : {}),
    ...(hostTools?.workflows ? { workflows: hostTools.workflows } : {}),
    ...(exaApiKey
      ? {
          webSearch: async (toolInput): Promise<WebSearchToolOutput> => {
            try {
              return await executeChatExaSearch({
                toolInput,
                apiKey: exaApiKey,
                signal,
                currentDate,
              });
            } catch (error) {
              return {
                ok: false,
                error: errorMessage(error),
              };
            }
          },
          webFetch: async (toolInput): Promise<WebFetchToolOutput> => {
            try {
              return await executeChatExaFetch({
                toolInput,
                apiKey: exaApiKey,
                signal,
              });
            } catch (error) {
              return {
                ok: false,
                error: errorMessage(error),
              };
            }
          },
        }
      : {}),
    ...(actionDispatcher ? { actions: actionDispatcher } : {}),
    ...(taskContext
      ? {
          limits: {
            webSearchCallsPerTurn: 20,
            webFetchCallsPerTurn: 20,
            actionCallsPerTurn: 20,
          },
        }
      : {}),
  });
  const baseSystem = createProductChatSystemPrompt({
    currentDate,
    webFetchEnabled: Boolean(exaApiKey),
    webSearchEnabled: Boolean(exaApiKey),
    browserToolsEnabled: Boolean(hostTools?.browserTools),
    taskToolsEnabled: Boolean(hostTools?.bootstrap.taskToolsEnabled),
    scheduleToolsEnabled: Boolean(hostTools?.bootstrap.taskToolsEnabled),
    brainCaptureEnabled: Boolean(brainCapture),
    activeBrain: brain
      ? {
          name: brain.name,
          workspaceName: hostTools?.bootstrap.workspaceName ?? brain.name,
          readOnly: !brainCapture,
        }
      : null,
    ...(hostTools
      ? {
          userContext: hostTools.bootstrap.userContext,
          recurringSchedules: hostTools.bootstrap.recurringSchedules,
          skillsAvailable: hostTools.bootstrap.skills.length > 0,
          workflows: hostTools.bootstrap.workflows,
        }
      : {}),
    ...(actionDispatcher?.catalog.sources.length
      ? {
          actionSources: actionDispatcher.catalog.sources,
          connectedIntegrations: actionDispatcher.catalog.sources,
        }
      : {}),
  });
  const taskSkillBundles = taskContext
    ? await loadWorkflowTaskSkillBundles(taskContext.harnessSpec)
    : [];
  const taskSystemBlocks = taskContext
    ? [
        TASK_SYSTEM_BLOCK,
        TASK_UNTRUSTED_CONTENT_SAFETY_BLOCK,
        ...(taskContext.harnessSpec.systemBlocks?.length
          ? taskContext.harnessSpec.systemBlocks
          : taskContext.harnessSpec.systemPrompt.trim()
            ? [taskContext.harnessSpec.systemPrompt]
            : []),
        ...taskSkillBundles.map(
          (bundle) =>
            `<workflow_skill name=${JSON.stringify(bundle.name)}>\n${bundle.body}\n</workflow_skill>`,
        ),
      ]
    : [];
  return {
    model,
    brain,
    activeSkills: hostTools?.activeSkills ?? [],
    toolContext,
    system: [baseSystem, ...taskSystemBlocks].join("\n\n"),
    maxSteps: taskContext
      ? Math.max(1, taskContext.harnessSpec.maxModelSteps || CHAT_MAX_STEPS)
      : hostTools?.browserTools
        ? CHAT_MAX_STEPS_WITH_SANDBOX
        : CHAT_MAX_STEPS,
    cleanup: hostTools?.close ?? (async () => undefined),
  };
}

function createProductAbortWatcher(input: {
  signalController: AbortController;
  projector: Pick<ProductChatProjector, "checkAbort">;
  shouldAbort?: () => Error | null;
}) {
  let stopped = false;
  let checkInFlight: Promise<void> | null = null;
  const abort = (error: unknown) => {
    if (input.signalController.signal.aborted) return;
    input.signalController.abort(
      error instanceof Error ? error : new Error("opencompany chat turn was aborted."),
    );
  };
  const checkNow = () => {
    if (stopped) return Promise.resolve();
    if (checkInFlight) return checkInFlight;
    checkInFlight = Promise.resolve()
      .then(async () => {
        const externalAbort = input.shouldAbort?.();
        if (externalAbort) throw externalAbort;
        await input.projector.checkAbort();
      })
      .catch((error) => {
        abort(error);
        throw error;
      })
      .finally(() => {
        checkInFlight = null;
      });
    return checkInFlight;
  };
  const timer = setInterval(() => {
    void checkNow().catch(() => undefined);
  }, INTERRUPT_POLL_INTERVAL_MS);
  timer.unref?.();

  return {
    checkNow,
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await checkInFlight?.catch(() => undefined);
    },
  };
}

function productToolPart(input: {
  part: Record<string, unknown>;
  toolCallId: string;
  toolName: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
}): ProductChatUiPart {
  const dynamic = input.part.dynamic === true;
  const providerMetadata = input.part.providerMetadata;
  const isOutput = input.state === "output-available" || input.state === "output-error";
  return {
    type: dynamic ? "dynamic-tool" : `tool-${input.toolName}`,
    ...(dynamic ? { toolName: input.toolName } : {}),
    toolCallId: input.toolCallId,
    state: input.state,
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.errorText ? { errorText: input.errorText } : {}),
    ...(typeof input.part.title === "string" ? { title: input.part.title } : {}),
    ...(input.part.toolMetadata ? { toolMetadata: input.part.toolMetadata } : {}),
    ...(input.part.providerExecuted === true ? { providerExecuted: true } : {}),
    ...(input.part.preliminary === true ? { preliminary: true } : {}),
    ...(providerMetadata && isOutput ? { resultProviderMetadata: providerMetadata } : {}),
    ...(providerMetadata && !isOutput ? { callProviderMetadata: providerMetadata } : {}),
  };
}

function providerMetadataFrom(part: Record<string, unknown>) {
  return part.providerMetadata ? { providerMetadata: part.providerMetadata } : {};
}

function finalizeStreamingParts(parts: readonly ProductChatUiPart[]) {
  return parts.map((part) =>
    (part.type === "text" || part.type === "reasoning") && part.state === "streaming"
      ? { ...part, state: "done" }
      : { ...part },
  );
}

function withCompletedResponseFallback(projection: ProductChatProjection): ProductChatProjection {
  if (
    projection.parts.some(
      (part) => part.type === "text" && typeof part.text === "string" && part.text.trim(),
    )
  ) {
    return projection;
  }
  return {
    ...projection,
    parts: [
      ...projection.parts,
      {
        type: "text",
        text: "I could not produce a response. Try sending that again.",
        state: "done",
      },
    ],
  };
}

function cloneParts(parts: readonly ProductChatUiPart[]) {
  return structuredClone(parts) as ProductChatUiPart[];
}

function partAt(parts: readonly ProductChatUiPart[], index: number) {
  const part = parts[index];
  if (!part) throw new Error(`opencompany chat projection part ${index} was not found.`);
  return part;
}

function recognizedAbortError(value: unknown): value is Error {
  return (
    value instanceof CodexChatHandoffError ||
    value instanceof ProductChatInterruptedError ||
    value instanceof TaskTurnTerminalError ||
    value instanceof CodexChatLeaseLostError
  );
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortReason(signal, "opencompany chat turn was aborted.");
}

function abortReason(signal: AbortSignal, fallback: string) {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function isLanguageModelUsage(value: unknown): value is LanguageModelUsage {
  return isRecord(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function readStringAllowEmpty(value: unknown) {
  return typeof value === "string" ? value : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function projectionText(projection: ProductChatProjection) {
  return projection.parts
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("")
    .trim();
}

export function approvalDraftsFromProjection(projection: ProductChatProjection) {
  const seen = new Set<string>();
  return projection.parts.flatMap((part) => {
    if (part.state !== "approval-requested" || !isRecord(part.approval)) return [];
    const approvalId = readString(part.approval.id);
    const toolCallId = readString(part.toolCallId);
    if (!approvalId || !toolCallId || seen.has(approvalId)) return [];
    seen.add(approvalId);
    const toolName =
      readString(part.toolName) ??
      (part.type.startsWith("tool-") ? part.type.slice("tool-".length) : "tool");
    const action = isRecord(part.input) ? readString(part.input.action) : null;
    return [
      {
        id: approvalId,
        toolCallId,
        kind: toolName,
        prompt: action ? `Approve ${action}?` : `Approve ${toolName}?`,
        ...(action ? { action } : {}),
        options: ["approved", "denied"] as const,
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
