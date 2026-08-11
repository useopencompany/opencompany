import { AGENT_MODEL_CATALOG, modelSupportsAttachments } from "@opencompany/agent-runtime";
import type { AgentModelId } from "@opencompany/agent-runtime/types";
import { ensureGoatMonthlyIncludedUsage } from "@opencompany/db/goat-billing";
import { hasPositiveGoatCreditBalance } from "@opencompany/db/goat-credits";
import { resolveGoatImessageDelivery } from "@opencompany/db/goat-imessage";
import {
  type GoatChatMessageAttachment,
  type GoatCodexChatSession,
  type GoatCodexChatTurn,
  goatChatMessages,
} from "@opencompany/db/goat-schema";
import {
  DEFAULT_GOAT_BRAIN_SLUG,
  getGoatBrainAccess,
  getGoatWorkspaceRole,
  listAccessibleGoatBrains,
} from "@opencompany/db/goat-workspaces";
import { resolveGoatActionCatalog } from "@opencompany/goat-agent/actions/catalog";
import { executeGoatAction } from "@opencompany/goat-agent/actions/execute";
import { projectActionCatalog } from "@opencompany/goat-agent/actions/policy";
import type { GoatResolvedActionCatalog } from "@opencompany/goat-agent/actions/types";
import {
  createOpenCompanyChatToolContext,
  OPENCOMPANY_CHAT_MAX_STEPS,
  OPENCOMPANY_CHAT_MAX_STEPS_WITH_SANDBOX,
  prepareOpenCompanyChatStep,
  TASK_SYSTEM_BLOCK,
  TASK_UNTRUSTED_CONTENT_SAFETY_BLOCK,
} from "@opencompany/goat-agent/chat-agent";
import type {
  GoatChatActionCatalog,
  GoatChatUiMessage,
  GoatStoredChatMessage,
  WebFetchToolOutput,
  WebSearchToolOutput,
} from "@opencompany/goat-agent/chat-ui";
import {
  replaceGoatChatUiMessageText,
  textFromGoatChatUiMessage,
  toGoatChatUiMessage,
} from "@opencompany/goat-agent/chat-ui";
import { executeGoatChatExaFetch } from "@opencompany/goat-agent/chat-web-fetch";
import { executeGoatChatExaSearch } from "@opencompany/goat-agent/chat-web-search";
import { resolveGoatImessageProvider } from "@opencompany/goat-agent/imessage/provider";
import { createGoatSendUserMessageRunner } from "@opencompany/goat-agent/imessage/send-user-message";
import { createOpenCompanyChatSystemPrompt } from "@opencompany/goat-agent/prompts";
import {
  createGoatGatewayAttribution,
  goatGatewayProviderOptions,
} from "@opencompany/goat-observability";
import { flushLatitude } from "@opencompany/goat-observability/latitude";
import { createLogger } from "@opencompany/observability";
import { getBraintrustAISDK } from "@opencompany/observability/braintrust";
import * as ai from "ai";
import {
  convertToModelMessages,
  createGateway,
  type LanguageModelUsage,
  parsePartialJson,
  stepCountIs,
} from "ai";
import { asc, eq } from "drizzle-orm";
import { downloadBlobBytes } from "./attachment-hydration";
import { getDb } from "./db";
import type { RunnerEnv } from "./env";
import { runGoatTaskBrainRead } from "./goat-codex-brain-tool";
import {
  GoatCodexChatHandoffError,
  GoatCodexChatLeaseLostError,
  GoatTaskTurnTerminalError,
} from "./goat-codex-chat-errors";
import { createGoatOpenCompanyActionDispatcher } from "./goat-opencompany-action-gateway";
import { createGoatOpenCompanyBrainCaptureRunner } from "./goat-opencompany-brain-capture";
import {
  createGoatOpenCompanyChatProjector,
  GoatOpenCompanyChatInterruptedError,
  type GoatOpenCompanyChatProjection,
  type GoatOpenCompanyChatProjector,
  type GoatOpenCompanyChatUiPart,
} from "./goat-opencompany-chat-projector";
import {
  attachGoatHostSkillsToPrompt,
  loadGoatOpenCompanyHostTools,
} from "./goat-opencompany-host-tools";
import {
  buildGoatTaskTerminalProjection,
  buildGoatTaskTurnCompletion,
  closeGoatTaskTurn,
  type GoatTaskTurnContext,
  markGoatTaskTurnRunning,
} from "./goat-task-turn";

const ASSISTANT_PARTS_FLUSH_INTERVAL_MS = 500;
const INTERRUPT_POLL_INTERVAL_MS = 500;

const logger = createLogger({
  service: "opencompany-runner",
  runtime: "goat-opencompany-chat",
});

function isTextExtractableAttachment(attachment: Pick<GoatChatMessageAttachment, "kind">) {
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

export async function runGoatOpenCompanyChatTurn(input: {
  turn: GoatCodexChatTurn;
  session: GoatCodexChatSession;
  env: RunnerEnv;
  taskContext?: GoatTaskTurnContext | undefined;
  canonicalAttemptId?: string;
  shouldAbort?: () => Error | null;
}): Promise<"settled" | "handed_off"> {
  const { turn, session, env } = input;
  const leaseId = turn.leaseId;
  const leaseOwner = turn.leaseOwner;
  if (!leaseId || !leaseOwner) {
    throw new Error(`Claimed OpenCompany chat turn ${turn.id} is missing its lease.`);
  }
  if (session.engine !== "opencompany") {
    throw new Error(`Session ${session.id} is not an OpenCompany-engine session.`);
  }

  const projector = createGoatOpenCompanyChatProjector({
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
      leaseId,
      leaseOwner,
      ...(input.canonicalAttemptId ? { canonicalAttemptId: input.canonicalAttemptId } : {}),
      turnStartedAt:
        turn.runAfter && turn.runAfter > turn.createdAt ? turn.runAfter : turn.createdAt,
    },
  });
  let projection = turn.settings.approvalContinuation
    ? await loadGoatOpenCompanyChatProjection(turn.assistantMessageId)
    : { parts: [] };
  await projector.started();

  if (turn.interruptRequestedAt) {
    await projector.interrupted(
      projection,
      input.taskContext ? buildGoatTaskTerminalProjection(input.taskContext) : null,
    );
    return "settled";
  }

  if (session.workspaceId) {
    if (!(await hasGoatHostedTurnCredits(session.workspaceId))) {
      const message =
        "This workspace is out of credits. Hobby usage refreshes on the first of the month; Pro admins can add credits in Settings → Billing.";
      projection = { parts: [{ type: "text", text: message }] };
      await projector.failed(
        message,
        projection,
        input.taskContext ? buildGoatTaskTerminalProjection(input.taskContext) : null,
      );
      return "settled";
    }
  }

  const generationController = new AbortController();
  const abortWatcher = createOpenCompanyAbortWatcher({
    signalController: generationController,
    projector,
    ...(input.shouldAbort ? { shouldAbort: input.shouldAbort } : {}),
  });
  let runtimeCleanup: (() => Promise<void>) | null = null;

  try {
    await abortWatcher.checkNow();
    if (input.taskContext) {
      await markGoatTaskTurnRunning({ context: input.taskContext, turn });
    }
    const runtime = await resolveOpenCompanyChatRuntime({
      turn,
      session,
      env,
      signal: generationController.signal,
      taskContext: input.taskContext,
    });
    runtimeCleanup = runtime.cleanup;
    throwIfAborted(generationController.signal);
    const messages = await loadGoatOpenCompanyChatModelMessages({
      chatSessionId: session.chatSessionId,
      currentUserMessageId: turn.userMessageId,
      modelId: runtime.model,
      blobToken: env.blobReadWriteToken,
      includeCurrentAssistantMessage: turn.settings.approvalContinuation === true,
      activeSkills: runtime.activeSkills,
    });
    throwIfAborted(generationController.signal);
    const gateway = createGateway({ apiKey: env.vercelAiGatewayApiKey });
    const { streamText } = getBraintrustAISDK(ai);
    const attribution = createGoatGatewayAttribution({
      userWorkosId: turn.userWorkosId,
      feature: input.taskContext ? "task" : "chat",
      chatSessionId: session.chatSessionId,
      ...(input.taskContext ? { taskId: input.taskContext.task.id } : {}),
      ...(runtime.brain ? { brainRef: runtime.brain.id } : {}),
    });
    const stream = streamText({
      model: gateway(runtime.model),
      system: runtime.system,
      messages,
      tools: runtime.toolContext.tools,
      stopWhen: stepCountIs(runtime.maxSteps),
      prepareStep: ({ stepNumber }) =>
        prepareOpenCompanyChatStep({
          stepNumber,
          maxSteps: runtime.maxSteps,
        }),
      ...(runtime.toolContext.repairToolCall
        ? { experimental_repairToolCall: runtime.toolContext.repairToolCall }
        : {}),
      abortSignal: generationController.signal,
      providerOptions: goatGatewayProviderOptions(attribution),
    });

    projection = await consumeGoatOpenCompanyChatStream({
      fullStream: stream.fullStream,
      signal: generationController.signal,
      sink: {
        project: async (nextProjection) => {
          projection = nextProjection;
          await projector.project(nextProjection);
        },
        recordStepUsage: (usage) => projector.recordStepUsage(usage),
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
      ? await closeGoatTaskTurn({
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
        ? buildGoatTaskTurnCompletion({
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
    if (effectiveError instanceof GoatCodexChatHandoffError) {
      return "handed_off";
    }
    if (
      effectiveError instanceof GoatOpenCompanyChatInterruptedError ||
      effectiveError instanceof GoatTaskTurnTerminalError
    ) {
      await projector.interrupted(
        projection,
        input.taskContext ? buildGoatTaskTerminalProjection(input.taskContext) : null,
      );
      return "settled";
    }
    if (effectiveError instanceof GoatCodexChatLeaseLostError) {
      throw effectiveError;
    }

    const message = errorMessage(effectiveError);
    logger.warn("Durable OpenCompany chat turn execution failed", {
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
      input.taskContext ? buildGoatTaskTerminalProjection(input.taskContext) : null,
    );
    return "settled";
  } finally {
    await abortWatcher.stop();
    await runtimeCleanup?.().catch((error) => {
      logger.warn("Durable OpenCompany Chat host cleanup failed", {
        event: "opencompany.goat_opencompany_chat_host_cleanup_failed",
        turn_id: turn.id,
        error: errorMessage(error),
      });
    });
    await flushLatitude();
  }
}

export async function hasGoatHostedTurnCredits(workspaceId: string, db = getDb()) {
  await ensureGoatMonthlyIncludedUsage(workspaceId, { db });
  return hasPositiveGoatCreditBalance(workspaceId, db);
}

export async function consumeGoatOpenCompanyChatStream(input: {
  fullStream: AsyncIterable<unknown>;
  signal: AbortSignal;
  sink: Pick<GoatOpenCompanyChatProjector, "project" | "recordStepUsage">;
  flushIntervalMs?: number;
  now?: () => number;
  initialProjection?: GoatOpenCompanyChatProjection;
}): Promise<GoatOpenCompanyChatProjection> {
  const parts: GoatOpenCompanyChatUiPart[] = cloneParts(input.initialProjection?.parts ?? []);
  const textPartIndexes = new Map<string, number>();
  const reasoningPartIndexes = new Map<string, number>();
  const toolPartIndexes = new Map<string, number>();
  const toolInputBuffers = new Map<string, string>();
  const flushIntervalMs = input.flushIntervalMs ?? ASSISTANT_PARTS_FLUSH_INTERVAL_MS;
  const now = input.now ?? Date.now;
  let lastFlushAt = now() - flushIntervalMs;
  let dirty = false;
  let latestUsage: LanguageModelUsage | undefined;
  let finishReason: string | undefined;
  let stepIndex = 0;

  for (const [index, part] of parts.entries()) {
    if (typeof part.toolCallId === "string") toolPartIndexes.set(part.toolCallId, index);
  }

  const projection = (): GoatOpenCompanyChatProjection => ({
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
  const appendPart = (part: GoatOpenCompanyChatUiPart) => {
    parts.push(part);
    dirty = true;
    return parts.length - 1;
  };
  const replacePart = (index: number, part: GoatOpenCompanyChatUiPart) => {
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
              openCompanyToolPart({
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
          const nextPart = openCompanyToolPart({
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
        const toolCallId = readString(part.toolCallId);
        const approvalId = readString(part.approvalId);
        const index = toolCallId ? toolPartIndexes.get(toolCallId) : undefined;
        if (toolCallId && approvalId && index !== undefined) {
          replacePart(index, {
            ...partAt(parts, index),
            state: "approval-requested",
            approval: { id: approvalId },
          });
          await flush(true);
        }
      } else if (part.type === "tool-result") {
        const toolCallId = readString(part.toolCallId);
        const toolName = readString(part.toolName);
        if (toolCallId && toolName) {
          const nextPart = openCompanyToolPart({
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
          await flush(true);
        }
      } else if (part.type === "tool-error") {
        const toolCallId = readString(part.toolCallId);
        const toolName = readString(part.toolName);
        if (toolCallId && toolName) {
          const nextPart = openCompanyToolPart({
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
          : new Error(readString(part.error) ?? "Goat model stream failed.");
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
    if (!(abort instanceof GoatCodexChatLeaseLostError)) {
      const finalizedParts = finalizeStreamingParts(parts);
      parts.splice(0, parts.length, ...finalizedParts);
      dirty = true;
      await flush(true);
    }
    throw error;
  }

  throwIfAborted(input.signal);
  const finalizedParts = finalizeStreamingParts(parts);
  parts.splice(0, parts.length, ...finalizedParts);
  dirty = true;
  await flush(true);
  return projection();
}

export async function goatOpenCompanyModelMessagesFromStored(
  storedMessages: readonly GoatStoredChatMessage[],
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
    throw new Error(`OpenCompany chat user message ${currentUserMessageId} was not found.`);
  }
  const nextMessage = storedMessages[currentIndex + 1];
  const replayMessages = storedMessages.slice(
    0,
    currentIndex +
      (options?.includeCurrentAssistantMessage && nextMessage?.role === "assistant" ? 2 : 1),
  );
  const uiMessages = replayMessages.map((message) => {
    const uiMessage = toGoatChatUiMessage(message);
    return message.id === currentUserMessageId && options?.activeSkills?.length
      ? replaceGoatChatUiMessageText(
          uiMessage,
          attachGoatHostSkillsToPrompt(textFromGoatChatUiMessage(uiMessage), options.activeSkills),
        )
      : uiMessage;
  });
  return convertToModelMessages(
    await hydrateGoatOpenCompanyAttachmentParts({
      uiMessages,
      storedMessages: replayMessages,
      modelId: options?.modelId,
      blobToken: options?.blobToken,
    }),
  );
}

async function loadGoatOpenCompanyChatModelMessages(input: {
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
      id: goatChatMessages.id,
      sessionId: goatChatMessages.sessionId,
      role: goatChatMessages.role,
      content: goatChatMessages.content,
      taskId: goatChatMessages.taskId,
      debugTrace: goatChatMessages.debugTrace,
      attachments: goatChatMessages.attachments,
      attachmentTexts: goatChatMessages.attachmentTexts,
      createdAt: goatChatMessages.createdAt,
      updatedAt: goatChatMessages.updatedAt,
    })
    .from(goatChatMessages)
    .where(eq(goatChatMessages.sessionId, input.chatSessionId))
    .orderBy(asc(goatChatMessages.createdAt), asc(goatChatMessages.id));
  const storedMessages: GoatStoredChatMessage[] = rows.map((row) => ({
    ...row,
    taskDisplayId: null,
    taskName: null,
    taskPrompt: null,
    taskStatus: null,
  }));
  return goatOpenCompanyModelMessagesFromStored(storedMessages, input.currentUserMessageId, {
    modelId: input.modelId,
    blobToken: input.blobToken,
    includeCurrentAssistantMessage: input.includeCurrentAssistantMessage,
    ...(input.activeSkills ? { activeSkills: input.activeSkills } : {}),
  });
}

async function loadGoatOpenCompanyChatProjection(
  assistantMessageId: string,
): Promise<GoatOpenCompanyChatProjection> {
  const [message] = await getDb()
    .select({ debugTrace: goatChatMessages.debugTrace })
    .from(goatChatMessages)
    .where(eq(goatChatMessages.id, assistantMessageId))
    .limit(1);
  const parts = message?.debugTrace?.uiMessageParts;
  return {
    parts: Array.isArray(parts) ? (structuredClone(parts) as GoatOpenCompanyChatUiPart[]) : [],
  };
}

async function hydrateGoatOpenCompanyAttachmentParts(input: {
  uiMessages: GoatChatUiMessage[];
  storedMessages: readonly Pick<
    GoatStoredChatMessage,
    "id" | "role" | "attachments" | "attachmentTexts"
  >[];
  modelId: string | undefined;
  blobToken: string | undefined;
}): Promise<GoatChatUiMessage[]> {
  const attachmentsByMessageId = new Map<
    string,
    {
      attachments: GoatChatMessageAttachment[];
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

      const parts: GoatChatUiMessage["parts"] = [...message.parts];
      for (const attachment of stored.attachments) {
        parts.push(
          ...(await openCompanyAttachmentToParts({
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

async function openCompanyAttachmentToParts(input: {
  attachment: GoatChatMessageAttachment;
  attachmentTexts: Record<string, string> | null;
  capabilities: { images: boolean; pdf: boolean };
  blobToken: string | undefined;
}): Promise<GoatChatUiMessage["parts"]> {
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
    logger.warn("Durable OpenCompany chat attachment hydration failed", {
      event: "opencompany.goat_opencompany_chat_attachment_hydration_failed",
      kind: attachment.kind,
      error: error instanceof Error ? error.name : "unknown",
    });
    return [{ type: "text", text: `${label} - the file could not be loaded.` }];
  }
}

async function resolveOpenCompanyChatRuntime(input: {
  turn: GoatCodexChatTurn;
  session: GoatCodexChatSession;
  env: RunnerEnv;
  signal: AbortSignal;
  taskContext?: GoatTaskTurnContext | undefined;
}) {
  const { turn, session, env, signal, taskContext } = input;
  const model = session.model as AgentModelId;
  if (!AGENT_MODEL_CATALOG.some((candidate) => candidate.id === model)) {
    throw new Error(`Unsupported OpenCompany chat model: ${session.model}.`);
  }
  if (!session.workspaceId) {
    throw new Error("Durable OpenCompany chat session is missing its workspace.");
  }
  const workspaceId = session.workspaceId;
  const workspaceRole = await getGoatWorkspaceRole(
    { userWorkosId: turn.userWorkosId, workspaceId },
    { db: getDb() },
  );
  if (!workspaceRole) {
    throw new Error("You no longer have access to this chat's workspace.");
  }

  let brain = null;
  if (session.brainRef) {
    const access = await getGoatBrainAccess(
      { userWorkosId: turn.userWorkosId, brainRef: session.brainRef },
      { db: getDb() },
    );
    if (!access || access.brain.workspaceId !== workspaceId) {
      throw new Error("You no longer have access to this chat's Brain.");
    }
    brain = access.brain;
  } else {
    const brains = await listAccessibleGoatBrains(
      { userWorkosId: turn.userWorkosId, workspaceId },
      { db: getDb() },
    );
    brain =
      brains.find((candidate) => candidate.slug === DEFAULT_GOAT_BRAIN_SLUG) ?? brains[0] ?? null;
  }

  const resolved = await resolveGoatActionCatalog({
    userWorkosId: turn.userWorkosId,
    workspaceId,
  }).catch(() => ({ providers: [], actions: [] }) as GoatResolvedActionCatalog);
  const onCatalog = projectActionCatalog(resolved, "headless");
  const dispatcherCatalog: GoatChatActionCatalog = {
    sources: onCatalog.providers.map((source) => ({
      ...source,
      kind: source.kind ?? "integration",
    })),
    actions: onCatalog.actions.map((action) => ({
      id: action.id,
      source: action.provider,
      description: action.description,
      params: action.params,
      permissionMode: action.permissionMode,
    })),
  };
  const directActionDispatcher =
    dispatcherCatalog.actions.length > 0
      ? {
          catalog: dispatcherCatalog,
          execute: (call: {
            action: string;
            params: Record<string, unknown>;
            toolCallId: string;
          }) =>
            executeGoatAction({
              catalog: onCatalog,
              actionId: call.action,
              params: call.params,
              userWorkosId: turn.userWorkosId,
              workspaceId,
              chatSessionId: session.chatSessionId,
              toolCallId: call.toolCallId,
              signal,
              currentDate: new Date(),
              userTimezone: "UTC",
            }),
        }
      : null;
  const actionDispatcher = taskContext
    ? directActionDispatcher
    : await createGoatOpenCompanyActionDispatcher({
        sessionId: session.id,
        turnId: turn.id,
        env,
        signal,
        approvalContinuation: Boolean(turn.settings.approvalContinuation),
      });
  const hostTools = taskContext
    ? null
    : await loadGoatOpenCompanyHostTools({
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
      ? createGoatOpenCompanyBrainCaptureRunner({
          sessionId: session.id,
          turnId: turn.id,
          env,
          signal,
        })
      : null;
  const exaApiKey = env.exaApiKey?.trim();
  const imessageDelivery =
    resolveGoatImessageProvider() !== null
      ? await resolveGoatImessageDelivery(turn.userWorkosId, getDb()).catch(() => null)
      : null;
  const toolContext = createOpenCompanyChatToolContext({
    model,
    latestUserMessage: turn.prompt,
    ...(imessageDelivery
      ? {
          sendUserMessage: createGoatSendUserMessageRunner({
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
            runGoatTaskBrainRead({
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
    ...(hostTools?.runWiki ? { runWiki: hostTools.runWiki as never } : {}),
    ...(hostTools?.browserTools ? { browserTools: hostTools.browserTools } : {}),
    ...(hostTools?.browserProfiles ? { browserProfiles: hostTools.browserProfiles } : {}),
    ...(hostTools?.skills ? { skills: hostTools.skills } : {}),
    ...(hostTools?.workflows ? { workflows: hostTools.workflows } : {}),
    ...(exaApiKey
      ? {
          webSearch: async (toolInput): Promise<WebSearchToolOutput> => {
            try {
              return await executeGoatChatExaSearch({
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
              return await executeGoatChatExaFetch({
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
  const baseSystem = createOpenCompanyChatSystemPrompt({
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
  const taskSystemBlocks = taskContext
    ? [
        TASK_SYSTEM_BLOCK,
        TASK_UNTRUSTED_CONTENT_SAFETY_BLOCK,
        ...(taskContext.harnessSpec.systemBlocks?.length
          ? taskContext.harnessSpec.systemBlocks
          : taskContext.harnessSpec.systemPrompt.trim()
            ? [taskContext.harnessSpec.systemPrompt]
            : []),
      ]
    : [];
  return {
    model,
    brain,
    activeSkills: hostTools?.activeSkills ?? [],
    toolContext,
    system: [baseSystem, ...taskSystemBlocks].join("\n\n"),
    maxSteps: taskContext
      ? Math.max(1, taskContext.harnessSpec.maxModelSteps || OPENCOMPANY_CHAT_MAX_STEPS)
      : hostTools?.browserTools
        ? OPENCOMPANY_CHAT_MAX_STEPS_WITH_SANDBOX
        : OPENCOMPANY_CHAT_MAX_STEPS,
    cleanup: hostTools?.close ?? (async () => undefined),
  };
}

function createOpenCompanyAbortWatcher(input: {
  signalController: AbortController;
  projector: Pick<GoatOpenCompanyChatProjector, "checkAbort">;
  shouldAbort?: () => Error | null;
}) {
  let stopped = false;
  let checkInFlight: Promise<void> | null = null;
  const abort = (error: unknown) => {
    if (input.signalController.signal.aborted) return;
    input.signalController.abort(
      error instanceof Error ? error : new Error("OpenCompany chat turn was aborted."),
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

function openCompanyToolPart(input: {
  part: Record<string, unknown>;
  toolCallId: string;
  toolName: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
}): GoatOpenCompanyChatUiPart {
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

function finalizeStreamingParts(parts: readonly GoatOpenCompanyChatUiPart[]) {
  return parts.map((part) =>
    (part.type === "text" || part.type === "reasoning") && part.state === "streaming"
      ? { ...part, state: "done" }
      : { ...part },
  );
}

function withCompletedResponseFallback(
  projection: GoatOpenCompanyChatProjection,
): GoatOpenCompanyChatProjection {
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

function cloneParts(parts: readonly GoatOpenCompanyChatUiPart[]) {
  return structuredClone(parts) as GoatOpenCompanyChatUiPart[];
}

function partAt(parts: readonly GoatOpenCompanyChatUiPart[], index: number) {
  const part = parts[index];
  if (!part) throw new Error(`OpenCompany chat projection part ${index} was not found.`);
  return part;
}

function recognizedAbortError(value: unknown): value is Error {
  return (
    value instanceof GoatCodexChatHandoffError ||
    value instanceof GoatOpenCompanyChatInterruptedError ||
    value instanceof GoatTaskTurnTerminalError ||
    value instanceof GoatCodexChatLeaseLostError
  );
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortReason(signal, "OpenCompany chat turn was aborted.");
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

function projectionText(projection: GoatOpenCompanyChatProjection) {
  return projection.parts
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("")
    .trim();
}

function approvalDraftsFromProjection(projection: GoatOpenCompanyChatProjection) {
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
