import {
  GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
  modelSupportsAttachments,
} from "@opencompany/agent-runtime";
import { captureLlmUsageRecorded, captureModelSpendRecorded } from "@opencompany/analytics/server";
import { calculateModelUsageCost } from "@opencompany/billing";
import { projectActionCatalog } from "@opencompany/core/actions/policy";
import { resolveImessageProvider } from "@opencompany/core/imessage/provider";
import { createSendUserMessageRunner } from "@opencompany/core/imessage/send-user-message";
import { ensureMonthlyIncludedUsage, isCreditsEnforcementEnabled } from "@opencompany/db/billing";
import {
  approveCapabilityRunByToolCall,
  cancelCapabilityRunByToolCall,
} from "@opencompany/db/capabilities";
import { recordChatModelRoutingAttempt } from "@opencompany/db/chat-model-routing";
import { getDb } from "@opencompany/db/client";
import { hasPositiveCreditBalance, recordCreditDebit } from "@opencompany/db/credits";
import { type ImessageDelivery, resolveImessageDelivery } from "@opencompany/db/imessage";
import {
  type ChatMessageDebugTrace,
  chatSandboxUsage,
  type HarnessEngine,
} from "@opencompany/db/schema";
import { createLogger } from "@opencompany/observability";
import {
  createGatewayAttribution,
  gatewayProviderOptions,
  hashUserId,
  METRICS,
  recordChatTurn,
  recordCounter,
  recordHistogram,
  recordModelCost,
  SPANS,
  startSpan,
} from "@opencompany/telemetry";
import { flushLatitude, latitudeTelemetry } from "@opencompany/telemetry/latitude";
import {
  convertToModelMessages,
  createGateway,
  type LanguageModelUsage,
  smoothStream,
  stepCountIs,
  streamText,
} from "ai";
import { after } from "next/server";
import { isChatActionsKilled, resolveActionCatalog } from "@/lib/actions/catalog";
import { executeAction } from "@/lib/actions/execute";
import type { CapabilityTurnState, ResolvedActionCatalog } from "@/lib/actions/types";
import { maybeTriggerAutoRefill } from "@/lib/billing/auto-refill";
import { captureToBrainInbox } from "@/lib/brain-capture";
import { runBrainToolForUser } from "@/lib/brain-cli";
import {
  browserProfilesAvailable,
  createAgentSession,
  endAgentSession,
  listConnectedBrowserProfilesForUser,
} from "@/lib/browser-profiles";
import { MANAGED_CAPABILITY_ACTIONS_BY_ID } from "@/lib/capabilities/catalog";
import { evaluateManagedCapabilityApproval } from "@/lib/capabilities/execute";
import {
  createChatApprovalContinuationTurn,
  createChatUserTurn,
  createDbChatStore,
  newChatMessageId,
  persistChatAssistantMessage,
  settleStaleChatToolCalls,
} from "@/lib/chat";
import {
  createOpenCompanyChatDebugTrace,
  createOpenCompanyChatSystemPrompt,
  createOpenCompanyChatToolContext,
  normalizeAgentText,
  OPENCOMPANY_CHAT_MAX_STEPS,
  OPENCOMPANY_CHAT_MAX_STEPS_WITH_SANDBOX,
  prepareOpenCompanyChatStep,
  type StartedTask,
  stringifyFinishReason,
} from "@/lib/chat-agent";
import { captureChatMessageSent } from "@/lib/chat-analytics";
import { saveChatAttachmentsToBrain } from "@/lib/chat-attachment-capture";
import {
  extractChatAttachmentTexts,
  hydrateChatAttachmentParts,
  parseChatAttachmentsInput,
} from "@/lib/chat-attachments";
import { isAutoModelSelection } from "@/lib/chat-auto-model";
import { type ChatModelRoutingResult, resolveAutoModel } from "@/lib/chat-model-router";
import { parseOptimisticChatSessionId } from "@/lib/chat-navigation";
import { resolveChatRequestContext } from "@/lib/chat-request-auth";
import {
  clearActiveChatStream,
  getChatStreamContext,
  isChatResumeEnabled,
  newChatStreamId,
  setActiveChatStream,
  watchChatStop,
} from "@/lib/chat-streams";
import { generateChatTitleForMessage } from "@/lib/chat-title";
import {
  type ChatMessageMetadata,
  type ChatUiMessage,
  chatContextTokensFromUsage,
  type DeleteTaskScheduleToolOutput,
  type EditTaskScheduleToolOutput,
  listedActionSourceIdsFromMessages,
  listedSkillIdsFromMessages,
  replaceChatUiMessageText,
  settleIncompleteToolCallsInStoredParts,
  textFromChatUiMessage,
  type UseActionToolOutput,
  usedSkillIdsFromMessages,
  type WebFetchToolInput,
  type WebFetchToolOutput,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "@/lib/chat-ui";
import {
  CHAT_OUT_OF_CREDITS_MESSAGE,
  CHAT_PROMPT_MAX_LENGTH,
  validateChatInput,
} from "@/lib/chat-validation";
import { executeChatExaFetch } from "@/lib/chat-web-fetch";
import { executeChatExaSearch } from "@/lib/chat-web-search";
import { isClaudeCodeConnectedForUser } from "@/lib/claude-code-auth";
import { isCodexConnectedForUser } from "@/lib/codex-auth";
import { DEFAULT_MODEL } from "@/lib/model-options";
import type { ChatBrowserToolSession } from "@/lib/sandbox/browser-tools";
import {
  activateAndListChatSessionSkills,
  attachSkillsToPrompt,
  type ChatSessionSkillSnapshot,
  listSkillCatalog,
  MAX_CHAT_SKILL_BYTES,
  MAX_CHAT_SKILLS,
  readSkillMentionRefs,
  resolveSkillMentions,
  SkillMentionError,
  skillsByteLength,
} from "@/lib/skills";
import {
  createTaskScheduleForUser,
  deleteTaskScheduleForUser,
  listTaskSchedulesForUser,
  type TaskScheduleView,
  updateTaskScheduleForUser,
} from "@/lib/task-schedules";
import { createTaskForUser } from "@/lib/tasks";
import { createTaskFromWorkflow, generateWorkflowTaskTitle } from "@/lib/workflow-tasks";
import { listWorkflowCatalog, readWorkflowMentionRef } from "@/lib/workflows";

export const maxDuration = 800;
export const runtime = "nodejs";

const logger = createLogger({
  service: "opencompany-goat",
  runtime: "goat-chat",
});

type ChatRequestBody = {
  sessionId?: unknown;
  newSessionId?: unknown;
  model?: unknown;
  message?: unknown;
  mentions?: unknown;
};

export async function POST(request: Request): Promise<Response> {
  const auth = await resolveChatRequestContext(request);
  if (!auth.ok) return auth.response;
  const { context } = auth;

  const body = await readJsonBody(request);
  if (!body.ok) return new Response(body.error, { status: 400 });

  // Two request shapes share this route: a user message starting a normal
  // turn, and the client's re-send of the latest assistant message carrying
  // tool-approval decisions, which continues that paused turn without
  // inserting a user message.
  const message = parseUserMessage(body.value.message);
  const approvalMessage = message ? null : parseApprovalContinuationMessage(body.value.message);
  if (!message && !approvalMessage) {
    return new Response("Invalid chat message.", { status: 400 });
  }
  const continuationSessionId = approvalMessage
    ? (typeof body.value.sessionId === "string" ? body.value.sessionId.trim() : "") ||
      approvalMessage.metadata?.sessionId?.trim() ||
      null
    : null;
  if (approvalMessage && !continuationSessionId) {
    return new Response("Approval responses require the chat session id.", { status: 400 });
  }

  const parsedAttachments = message
    ? parseChatAttachmentsInput(message.metadata?.attachments, context.user.workosUserId)
    : null;
  if (parsedAttachments && !parsedAttachments.ok) {
    return new Response(parsedAttachments.error, { status: 400 });
  }
  const attachments = parsedAttachments?.ok ? parsedAttachments.attachments : [];
  const autoModelRequested = Boolean(message && isAutoModelSelection(body.value.model));

  const parsed = message
    ? validateChatInput({
        prompt: textFromChatUiMessage(message),
        model: autoModelRequested ? DEFAULT_MODEL : body.value.model,
        sessionId: body.value.sessionId,
        hasAttachments: attachments.length > 0,
      })
    : null;
  if (parsed && !parsed.ok) return new Response(parsed.error, { status: 400 });
  let userInput = parsed?.ok ? parsed.value : null;
  const parsedNewSessionId = message ? parseOptimisticChatSessionId(body.value.newSessionId) : null;
  if (parsedNewSessionId && !parsedNewSessionId.ok) {
    return new Response(parsedNewSessionId.error, { status: 400 });
  }
  const newSessionId = parsedNewSessionId?.ok ? parsedNewSessionId.sessionId : null;
  if (userInput?.sessionId && newSessionId) {
    return new Response("A chat request cannot continue and create a session at the same time.", {
      status: 400,
    });
  }

  if (autoModelRequested && !context.user.autoModelRoutingEnabled) {
    return new Response("Auto model routing is not enabled for this account.", { status: 403 });
  }
  if (autoModelRequested && userInput?.sessionId) {
    return new Response("Auto model routing is only available when starting a new chat.", {
      status: 400,
    });
  }

  if (userInput && !autoModelRequested) {
    const attachmentCapabilities = modelSupportsAttachments(userInput.model);
    if (
      attachments.some((attachment) => attachment.kind === "image") &&
      !attachmentCapabilities.images
    ) {
      return new Response("The selected model does not support image attachments.", {
        status: 400,
      });
    }
    if (
      attachments.some((attachment) => attachment.kind === "pdf") &&
      !attachmentCapabilities.pdf
    ) {
      return new Response("The selected model does not support PDF attachments.", { status: 400 });
    }
  }

  const mentionEngine = message ? readChatMentionEngine(body.value.mentions) : undefined;
  const requestedEngine = mentionEngine
    ? await resolveConnectedChatMentionEngine({
        engine: mentionEngine,
        userWorkosId: context.user.workosUserId,
      })
    : undefined;
  if (autoModelRequested && requestedEngine) {
    return new Response("Auto model routing cannot be combined with an engine mention.", {
      status: 400,
    });
  }
  if (requestedEngine && attachments.length > 0) {
    return new Response("Attachments are not supported in engine chats yet.", {
      status: 400,
    });
  }

  let resolvedSkills: Awaited<ReturnType<typeof resolveSkillMentions>> = [];
  if (message) {
    const parsedSkillMentions = readSkillMentionRefs(
      message.metadata?.mentions ?? body.value.mentions,
    );
    if (!parsedSkillMentions.ok) {
      return new Response(parsedSkillMentions.error, { status: 400 });
    }
    try {
      resolvedSkills = await resolveSkillMentions({
        workspaceId: context.workspace.id,
        mentions: parsedSkillMentions.mentions,
      });
    } catch (error) {
      if (error instanceof SkillMentionError) {
        return new Response(error.message, { status: 400 });
      }
      throw error;
    }
  }
  if (message) {
    const parsedWorkflowMention = readWorkflowMentionRef(
      message.metadata?.mentions ?? body.value.mentions,
    );
    if (!parsedWorkflowMention.ok) {
      return new Response(parsedWorkflowMention.error, { status: 400 });
    }
    if (parsedWorkflowMention.mention) {
      return new Response("Start workflow tasks through the workflows endpoint.", { status: 400 });
    }
  }
  const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!gatewayApiKey) {
    return new Response("Goat chat is not configured.", { status: 503 });
  }
  // Chat is usage-based on both plans: each turn debits the workspace's USD
  // credits, and a turn cannot start on an empty balance. Codex-engine turns
  // are exempt (the user's own Codex auth pays for those, not the gateway).
  if (!requestedEngine && isCreditsEnforcementEnabled()) {
    await ensureMonthlyIncludedUsage(context.workspace.id);
    const hasCredits = await hasPositiveCreditBalance(context.workspace.id).catch((error) => {
      logger.warn("Goat chat credit balance check failed", {
        event: "goat.chat_credit_balance_check_failed",
        workspace_id: context.workspace.id,
        error,
      });
      // Fail open: a transient balance-read failure must not block chat.
      return true;
    });
    if (!hasCredits) {
      return new Response(CHAT_OUT_OF_CREDITS_MESSAGE, { status: 402 });
    }
  }
  const exaApiKey = process.env.EXA_API_KEY?.trim();
  const canManageWorkspaceBrain = context.role === "admin";
  const brainCaptureEnabled = Boolean(context.activeBrain);
  const taskToolsEnabled = context.user.taskSpawningEnabled && canManageWorkspaceBrain;

  // Action and skill catalogs are resolved per request from real connection
  // and active-Brain state. Engine handoffs get neither: their execution
  // context is assembled separately, and main-chat skills must not leak into
  // delegated work.
  const actionsEnabled = !requestedEngine && !isChatActionsKilled();
  const emptyCatalog: ResolvedActionCatalog = { providers: [], actions: [] };
  const [resolvedActionCatalog, skillCatalog, workflowCatalog, modelRouting, imessageDelivery] =
    await Promise.all([
      actionsEnabled
        ? resolveActionCatalog({
            userWorkosId: context.user.workosUserId,
            workspaceId: context.workspace.id,
          }).catch((error) => {
            logger.warn("Goat chat action catalog resolution failed", {
              event: "goat.chat_action_catalog_resolution_failed",
              error,
            });
            return emptyCatalog;
          })
        : Promise.resolve(emptyCatalog),
      !requestedEngine
        ? listSkillCatalog(context.workspace.id).catch((error) => {
            logger.warn("Goat chat skill catalog resolution failed", {
              event: "goat.chat_skill_catalog_resolution_failed",
              error,
            });
            return [];
          })
        : Promise.resolve([]),
      !requestedEngine && context.user.taskSpawningEnabled
        ? listWorkflowCatalog(context.workspace.id).catch((error) => {
            logger.warn("Goat chat workflow catalog resolution failed", {
              event: "goat.chat_workflow_catalog_resolution_failed",
              error,
            });
            return [];
          })
        : Promise.resolve([]),
      autoModelRequested && userInput
        ? resolveAutoModel({
            prompt: userInput.prompt,
            attachments,
            gatewayApiKey,
            userWorkosId: context.user.workosUserId,
            workspaceId: context.workspace.id,
          })
        : Promise.resolve<ChatModelRoutingResult | null>(null),
      !requestedEngine && resolveImessageProvider() !== null
        ? resolveImessageDelivery(context.user.workosUserId).catch((error) => {
            logger.warn("Goat chat iMessage delivery resolution failed", {
              event: "goat.chat_imessage_delivery_resolution_failed",
              error,
            });
            return null;
          })
        : Promise.resolve<ImessageDelivery | null>(null),
    ]);
  const actionCatalog = projectActionCatalog(resolvedActionCatalog, "foregroundInteractive");
  if (modelRouting && userInput) {
    userInput = { ...userInput, model: modelRouting.model };
  }
  if (userInput && autoModelRequested) {
    const attachmentCapabilities = modelSupportsAttachments(userInput.model);
    if (
      attachments.some((attachment) => attachment.kind === "image") &&
      !attachmentCapabilities.images
    ) {
      return new Response("The selected model does not support image attachments.", {
        status: 400,
      });
    }
    if (
      attachments.some((attachment) => attachment.kind === "pdf") &&
      !attachmentCapabilities.pdf
    ) {
      return new Response("The selected model does not support PDF attachments.", { status: 400 });
    }
  }

  const store = createDbChatStore();
  const recurringSchedules = taskToolsEnabled
    ? await listTaskSchedulesForUser(context.user.workosUserId)
    : [];
  const startedAt = performance.now();
  const currentDate = new Date();
  const userIdHash = hashUserId(context.user.workosUserId);
  const elapsedChatDurationMs = () => Math.max(0, Math.round(performance.now() - startedAt));
  // Continuations do not carry a model in the request; the session's stored
  // model takes over once the turn is loaded.
  let telemetryModel = userInput?.model ?? "";
  const chatSpan = startSpan(SPANS.chatTurn, {
    ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
    "goat.model": telemetryModel,
    "goat.task_started": false,
    ...(autoModelRequested ? { "goat.model_selection": "auto" } : {}),
    ...(modelRouting
      ? {
          "goat.router_tier": modelRouting.tier,
          "goat.router_reason": modelRouting.reason,
          "goat.router_outcome": modelRouting.classifier.outcome,
          "goat.router_duration_ms": modelRouting.classifier.durationMs,
          "goat.router_error_category": modelRouting.classifier.errorCategory,
          "goat.router_finish_reason": modelRouting.classifier.finishReason,
          "goat.router_provider_status_code": modelRouting.classifier.providerStatusCode,
          "goat.router_provider_retryable": modelRouting.classifier.providerRetryable,
        }
      : {}),
    ...(approvalMessage ? { "goat.approval_continuation": true } : {}),
  });
  let chatFinished = false;
  const finishChatTelemetry = (
    outcome: "success" | "failure" | "aborted",
    attributes: Record<string, string | number | boolean | null | undefined> = {},
    error?: unknown,
  ) => {
    if (chatFinished) return;
    chatFinished = true;
    const durationMs = elapsedChatDurationMs();
    const failureCategory =
      outcome === "failure" && error
        ? chatSpan.fail(error, attributes)
        : outcome === "failure"
          ? ((attributes["goat.failure_category"] as string | undefined) ?? "unknown")
          : (attributes["goat.failure_category"] as string | undefined);
    const finalAttributes: Record<string, string | number | boolean | null | undefined> = {
      ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
      "goat.model": telemetryModel,
      "goat.outcome": outcome,
      ...(failureCategory ? { "goat.failure_category": failureCategory } : {}),
      ...attributes,
    };
    chatSpan.end(finalAttributes);
    recordChatTurn({
      durationMs,
      outcome,
      attributes: finalAttributes,
    });
    const logFields = {
      event: "opencompany.goat_chat_turn_finished",
      outcome,
      ...(failureCategory ? { failure_category: failureCategory } : {}),
      chat_session_id: finalAttributes["goat.chat_session_id"],
      chat_message_id: finalAttributes["goat.chat_message_id"],
      task_id: finalAttributes["goat.task_id"],
      model: finalAttributes["goat.model"],
      task_started: finalAttributes["goat.task_started"],
      duration_ms: durationMs,
    };
    if (outcome === "success") {
      logger.info("Goat chat turn finished", logFields);
    } else {
      logger.warn("Goat chat turn finished", logFields);
    }
  };

  // The two turn shapes normalize to this state so the streaming tail below
  // stays a single code path.
  type ChatTurnState = {
    session: Awaited<ReturnType<typeof createChatUserTurn>>["session"];
    sessionCreated: boolean;
    userMessageId: string;
    usageUserMessageId: string | null;
    userMessageContent: string;
    storedMessages: Awaited<ReturnType<typeof createChatUserTurn>>["storedMessages"];
    messages: ChatUiMessage[];
    respondedApprovals: Array<{
      approvalId: string;
      toolCallId: string;
      action: string;
      approved: boolean;
    }>;
    continuationTaskId: string | null;
  };
  let turn: ChatTurnState;
  try {
    if (message && userInput) {
      // Extract readable file text once at submit time; every later turn reads the
      // stored text instead of re-downloading the blob.
      const attachmentTexts =
        attachments.length > 0 ? await extractChatAttachmentTexts(attachments) : null;
      const userTurn = await createChatUserTurn(
        {
          userWorkosId: context.user.workosUserId,
          prompt: userInput.prompt,
          model: userInput.model,
          sessionId: userInput.sessionId,
          newSessionId,
          messageId: safeClientMessageId(message.id),
          attachments: attachments.length > 0 ? attachments : null,
          attachmentTexts,
        },
        store,
      );
      // Settle approvals the user talked past and tools interrupted by an
      // earlier stream so persisted history remains model-convertible.
      const settled = await settleStaleChatToolCalls(userTurn, store);
      await Promise.allSettled(
        settled.toolCallIds.map((toolCallId) =>
          cancelCapabilityRunByToolCall({
            toolCallId,
            chatSessionId: userTurn.session.id,
            userWorkosId: context.user.workosUserId,
            workspaceId: context.workspace.id,
          }),
        ),
      );
      turn = {
        session: userTurn.session,
        sessionCreated: userTurn.sessionCreated,
        userMessageId: userTurn.userMessage.id,
        usageUserMessageId: userTurn.userMessage.id,
        userMessageContent: userInput.prompt,
        storedMessages: userTurn.storedMessages,
        messages: settled.changed ? settled.messages : userTurn.messages,
        respondedApprovals: [],
        continuationTaskId: null,
      };
    } else {
      const continuation = await createChatApprovalContinuationTurn(
        {
          userWorkosId: context.user.workosUserId,
          sessionId: continuationSessionId ?? "",
          message: approvalMessage as ChatUiMessage,
        },
        store,
      );
      if (!continuation.ok) {
        finishChatTelemetry("failure", {
          "goat.failure_category": "approval_continuation_invalid",
        });
        return new Response(continuation.error, { status: 409 });
      }
      const managedResponses = continuation.respondedApprovals.filter((approval) =>
        MANAGED_CAPABILITY_ACTIONS_BY_ID.has(approval.action),
      );
      await Promise.allSettled(
        managedResponses.map(async (approval) => {
          const row = approval.approved
            ? await approveCapabilityRunByToolCall({
                toolCallId: approval.toolCallId,
                chatSessionId: continuation.session.id,
                userWorkosId: context.user.workosUserId,
                workspaceId: context.workspace.id,
              })
            : await cancelCapabilityRunByToolCall({
                toolCallId: approval.toolCallId,
                chatSessionId: continuation.session.id,
                userWorkosId: context.user.workosUserId,
                workspaceId: context.workspace.id,
              });
          if (row) {
            recordCounter(METRICS.capabilityApprovalsTotal, 1, {
              "goat.capability_source": row.source,
              "goat.capability_action": row.action,
              "goat.approval_decision": approval.approved ? "approve" : "cancel",
              "goat.outcome": row.status,
            });
          }
        }),
      );
      turn = {
        session: continuation.session,
        sessionCreated: false,
        userMessageId: continuation.lastUserMessage?.id ?? continuation.session.id,
        usageUserMessageId: continuation.lastUserMessage?.id ?? null,
        userMessageContent: continuation.lastUserMessage?.content ?? "",
        storedMessages: continuation.storedMessages,
        messages: continuation.messages,
        respondedApprovals: continuation.respondedApprovals,
        continuationTaskId: continuation.storedMessages.at(-1)?.taskId ?? null,
      };
    }
    telemetryModel = turn.session.model;
    chatSpan.setAttributes({
      "goat.chat_session_id": turn.session.id,
      "goat.chat_message_id": turn.userMessageId,
      "goat.model": turn.session.model,
    });
    if (modelRouting) {
      const routingUsage = modelRouting.classifier.usage
        ? normalizeChatModelUsage(modelRouting.classifier.usage)
        : null;
      try {
        await recordChatModelRoutingAttempt({
          workspaceId: context.workspace.id,
          userWorkosId: context.user.workosUserId,
          chatSessionId: turn.session.id,
          userMessageId: turn.userMessageId,
          classifierModel: modelRouting.classifier.model,
          selectedModel: modelRouting.model,
          tier: modelRouting.tier,
          reason: modelRouting.reason,
          outcome: modelRouting.classifier.outcome,
          durationMs: modelRouting.classifier.durationMs,
          ...(modelRouting.classifier.errorCategory
            ? { errorCategory: modelRouting.classifier.errorCategory }
            : {}),
          ...(modelRouting.classifier.finishReason
            ? { finishReason: modelRouting.classifier.finishReason }
            : {}),
          ...(modelRouting.classifier.providerStatusCode !== undefined
            ? { providerStatusCode: modelRouting.classifier.providerStatusCode }
            : {}),
          ...(modelRouting.classifier.providerRetryable !== undefined
            ? { providerRetryable: modelRouting.classifier.providerRetryable }
            : {}),
          promptLength: turn.userMessageContent.length,
          attachmentCount: attachments.length,
          inputTokens: routingUsage?.inputTokens ?? 0,
          outputTokens: routingUsage?.outputTokens ?? 0,
          totalTokens: routingUsage?.totalTokens ?? 0,
        });
      } catch (error) {
        logger.warn("Goat chat model routing attempt persistence failed", {
          event: "goat.chat_model_routing_attempt_persistence_failed",
          workspace_id: context.workspace.id,
          chat_session_id: turn.session.id,
          chat_message_id: turn.userMessageId,
          routing_outcome: modelRouting.classifier.outcome,
          error,
        });
      }
    }
    if (modelRouting?.classifier.usage) {
      after(
        recordChatModelCost({
          model: modelRouting.classifier.model,
          usage: modelRouting.classifier.usage,
          workspaceId: context.workspace.id,
          userWorkosId: context.user.workosUserId,
          chatSessionId: turn.session.id,
          userMessageId: turn.userMessageId,
          idempotencyKeySuffix: ":routing",
          stage: "routing",
        }),
      );
    }
  } catch (error) {
    finishChatTelemetry("failure", {}, error);
    throw error;
  }
  let sessionSkills: ChatSessionSkillSnapshot[];
  try {
    sessionSkills = await activateAndListChatSessionSkills({
      chatSessionId: turn.session.id,
      activatedMessageId: turn.userMessageId,
      workspaceRef: context.workspace.id,
      skills: message ? resolvedSkills : [],
    });
  } catch (error) {
    finishChatTelemetry("failure", {}, error);
    throw error;
  }
  const skillsByActivationMessageId = groupSessionSkillsByActivationMessage(sessionSkills);
  if (message && userInput) {
    after(
      generateChatTitleForMessage({
        sessionId: turn.session.id,
        messageId: turn.userMessageId,
        apiKey: gatewayApiKey,
      }).catch(() => undefined),
    );
    // One event covers both new and continued chats. `is_first_message` keeps the new-chat
    // funnel queryable without double-capturing the first user action.
    after(
      captureChatMessageSent({
        user: context.user,
        workspaceId: context.workspace.id,
        sessionId: turn.session.id,
        isFirstMessage: turn.sessionCreated,
        engine: turn.session.engine,
        model: turn.session.model,
        messageLength: userInput.prompt.length,
        selectionMode: autoModelRequested ? "auto" : "manual",
        ...(modelRouting
          ? {
              routingTier: modelRouting.tier,
              routingReason: modelRouting.reason,
              routingOutcome: modelRouting.classifier.outcome,
              routingDurationMs: modelRouting.classifier.durationMs,
              ...(modelRouting.classifier.errorCategory
                ? { routingErrorCategory: modelRouting.classifier.errorCategory }
                : {}),
              ...(modelRouting.classifier.finishReason
                ? { routingFinishReason: modelRouting.classifier.finishReason }
                : {}),
              ...(modelRouting.classifier.providerStatusCode !== undefined
                ? { routingProviderStatusCode: modelRouting.classifier.providerStatusCode }
                : {}),
              ...(modelRouting.classifier.providerRetryable !== undefined
                ? { routingProviderRetryable: modelRouting.classifier.providerRetryable }
                : {}),
            }
          : {}),
      }),
    );
  }

  // With resumable streams, a client disconnect (refresh, tab close, stop())
  // is just a dropped connection: generation keeps running and the client can
  // reattach. Explicit stops arrive via the stop endpoint, which aborts this
  // controller through the Redis stop signal. Without Redis, the request
  // signal keeps its old meaning: disconnect cancels generation.
  const resumeEnabled = isChatResumeEnabled();
  const stopController = new AbortController();
  const generationSignal = resumeEnabled ? stopController.signal : request.signal;
  const capabilityTurnState: CapabilityTurnState = {
    quotedTotalUsdMicros: 0,
    admittedToolCallIds: [],
    quotesByToolCallId: new Map(),
    asyncRunsStarted: 0,
  };
  let stopWatcherCleanup: (() => void) | null = null;
  let activeStreamId: string | null = null;
  const currentActionSourceIds = new Set(actionCatalog.providers.map((source) => source.id));
  const prelistedActionSourceIds = new Set(
    listedActionSourceIdsFromMessages(turn.messages).filter((sourceId) =>
      currentActionSourceIds.has(sourceId),
    ),
  );
  const currentSkillIds = new Set(skillCatalog.map((skill) => skill.id));
  const prelistedSkillIds = new Set(
    listedSkillIdsFromMessages(turn.messages).filter((skillId) => currentSkillIds.has(skillId)),
  );
  const activeSkillIds = new Set([
    ...sessionSkills.map((skill) => skill.skillId),
    ...usedSkillIdsFromMessages(turn.messages),
  ]);
  let loadedSkillCount = resolvedSkills.length;
  let loadedSkillBytes = skillsByteLength(resolvedSkills);
  const releaseStreamCoordination = () => {
    stopWatcherCleanup?.();
    stopWatcherCleanup = null;
    if (activeStreamId) {
      void clearActiveChatStream(turn.session.id, activeStreamId);
      activeStreamId = null;
    }
  };

  let browserToolSession: ChatBrowserToolSession | null = null;
  let connectedBrowserProfiles: Awaited<ReturnType<typeof listConnectedBrowserProfilesForUser>> =
    [];
  if (turn.session.engine === "opencompany" && !requestedEngine) {
    connectedBrowserProfiles = browserProfilesAvailable()
      ? await listConnectedBrowserProfilesForUser(context.user.workosUserId)
      : [];
    const { createChatBrowserToolSession } = await import("@/lib/sandbox/browser-tools");
    browserToolSession = createChatBrowserToolSession({
      chatSessionId: turn.session.id,
      userWorkosId: context.user.workosUserId,
      signal: generationSignal,
      ...(connectedBrowserProfiles.length > 0
        ? {
            createBrowserProfileAgentSession: (profileId) =>
              createAgentSession({
                userWorkosId: context.user.workosUserId,
                profileId,
                chatSessionId: turn.session.id,
                userMessageId: turn.usageUserMessageId,
              }),
            endBrowserProfileAgentSession: (session) =>
              endAgentSession({
                userWorkosId: context.user.workosUserId,
                profileId: session.profile.id,
                sessionId: session.sessionId,
              }),
          }
        : {}),
    });
  }
  const maxChatSteps = browserToolSession
    ? OPENCOMPANY_CHAT_MAX_STEPS_WITH_SANDBOX
    : OPENCOMPANY_CHAT_MAX_STEPS;
  let browserUsagePromise: Promise<void> | null = null;
  const recordBrowserSandboxUsage = () => {
    browserUsagePromise ??= (async () => {
      await browserToolSession?.endActiveProfile?.();
      const usage = browserToolSession?.getUsage();
      if (!usage) return;
      await getDb()
        .insert(chatSandboxUsage)
        .values({
          chatSessionId: turn.session.id,
          userWorkosId: context.user.workosUserId,
          userMessageId: turn.usageUserMessageId,
          sandboxId: usage.sandboxId,
          startedAt: usage.startedAt,
          endedAt: usage.endedAt,
          activeMs: usage.activeMs,
          rawMetrics: {
            ...usage.rawMetrics,
            sandboxName: usage.sandboxName,
          },
          costBasis: {
            provider: "vercel-sandbox",
            status: "unpriced",
          },
        });
    })().catch((error) => {
      logger.warn("Goat chat sandbox usage recording failed", {
        event: "goat.chat_sandbox_usage_recording_failed",
        chat_session_id: turn.session.id,
        error,
      });
    });
    return browserUsagePromise;
  };

  const toolContext = createOpenCompanyChatToolContext({
    model: turn.session.model,
    latestUserMessage: turn.userMessageContent,
    ...(requestedEngine ? { requestedEngine } : {}),
    ...(browserToolSession ? { browserTools: browserToolSession.execute } : {}),
    ...(imessageDelivery
      ? {
          sendUserMessage: createSendUserMessageRunner({
            userWorkosId: context.user.workosUserId,
            phoneE164: imessageDelivery.phoneE164,
            source: "chat",
            chatSessionId: turn.session.id,
            signal: generationSignal,
          }),
        }
      : {}),
    ...(browserToolSession && connectedBrowserProfiles.length > 0
      ? {
          browserProfiles: {
            profiles: connectedBrowserProfiles,
            useProfile: async (call) => {
              const profile = connectedBrowserProfiles.find((entry) => entry.name === call.profile);
              if (!profile) {
                return {
                  ok: false,
                  error: `Unknown browser profile ${JSON.stringify(call.profile)}.`,
                };
              }
              const result = await browserToolSession.useProfile({
                profileId: profile.id,
              });
              if (!result.profile) return result;
              return {
                ...result,
                profile: {
                  id: result.profile.id,
                  name: result.profile.name,
                  siteHost: result.profile.siteHost,
                },
              };
            },
          },
        }
      : {}),
    // goat_brain is read-only for everyone (recall/inspect). The only write path
    // in chat is save_to_brain, which is available to every workspace member
    // with an active brain and enqueues the durable ingestion agent.
    runBrainCli: (toolInput, toolExecutionContext) => {
      const toolCallId = brainToolCallId(toolExecutionContext);
      const activeBrain = context.activeBrain;
      if (!activeBrain) {
        return Promise.resolve({
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: "",
          error: "You do not have access to any brain in this workspace.",
        });
      }
      return runBrainToolForUser({
        brainRef: activeBrain.id,
        userWorkosId: context.user.workosUserId,
        toolInput,
        gatewayApiKey,
        sourceRef: `goat-chat:${turn.userMessageId}`,
        chatSessionId: turn.session.id,
        userMessageId: turn.userMessageId,
        ...(toolCallId ? { toolCallId } : {}),
        signal: generationSignal,
      });
    },
    ...(brainCaptureEnabled
      ? {
          saveToBrain: async (toolInput) => {
            const activeBrain = context.activeBrain;
            if (!activeBrain) {
              return {
                ok: false,
                error: "You do not have access to any brain in this workspace.",
              };
            }
            const attachmentIds = toolInput.attachmentIds ?? [];
            if (attachmentIds.length > 0) {
              return saveChatAttachmentsToBrain({
                brainRef: activeBrain.id,
                userWorkosId: context.user.workosUserId,
                attachmentIds,
                sessionMessages: turn.storedMessages,
              });
            }
            const content = toolInput.content?.trim();
            const sourceRef = toolInput.sourceRef?.trim();
            if (!content && !sourceRef) {
              return {
                ok: false,
                error: "Provide content, sourceRef, or attachmentIds to save.",
              };
            }
            const captured = await captureToBrainInbox({
              brainRef: activeBrain.id,
              userWorkosId: context.user.workosUserId,
              ...(content ? { text: content } : {}),
              ...(toolInput.title ? { title: toolInput.title } : {}),
              ...(toolInput.intent ? { intent: toolInput.intent } : {}),
              ...(sourceRef ? { sourceRef } : {}),
              ...(toolInput.integrationId ? { integrationId: toolInput.integrationId } : {}),
              ...(toolInput.fallbackContent ? { fallbackText: toolInput.fallbackContent } : {}),
              source: {
                kind: "chat",
                connectionId: turn.session.id,
                itemId: turn.userMessageId,
              },
            });
            if (!captured.ok) return captured;
            return {
              ok: true,
              draftId: captured.draftBrainId,
              path: captured.path,
              title: captured.title,
              status: captured.quotaPaused ? "paused_by_plan" : "captured",
              ...(captured.quotaPaused
                ? {
                    message:
                      "Saved to the brain inbox. Ingestion is paused by the workspace plan; see Settings → Usage or Billing to review the limit or upgrade.",
                  }
                : {}),
            };
          },
        }
      : {}),
    ...(exaApiKey
      ? {
          webFetch: (toolInput) =>
            executeChatWebFetch({
              toolInput,
              apiKey: exaApiKey,
              signal: generationSignal,
              attributes: {
                ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
                "goat.chat_session_id": turn.session.id,
                "goat.chat_message_id": turn.userMessageId,
                "goat.model": turn.session.model,
              },
              chatSpan,
            }),
          webSearch: (toolInput) =>
            executeChatWebSearch({
              toolInput,
              apiKey: exaApiKey,
              signal: generationSignal,
              currentDate,
              attributes: {
                ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
                "goat.chat_session_id": turn.session.id,
                "goat.chat_message_id": turn.userMessageId,
                "goat.model": turn.session.model,
              },
              chatSpan,
            }),
        }
      : {}),
    ...(skillCatalog.length > 0
      ? {
          skills: {
            catalog: skillCatalog.map((skill) => ({
              id: skill.id,
              name: skill.name,
              description: skill.description,
            })),
            ...(prelistedSkillIds.size > 0 ? { prelistedSkillIds: [...prelistedSkillIds] } : {}),
            execute: async ({ skill }: { skill: string }) => {
              try {
                const [resolved] = await resolveSkillMentions({
                  workspaceId: context.workspace.id,
                  mentions: [{ id: skill }],
                });
                if (!resolved) {
                  return {
                    ok: false as const,
                    skill,
                    error: {
                      code: "unavailable" as const,
                      message: `Skill "@skill/${skill}" is unavailable or incomplete.`,
                    },
                  };
                }
                if (activeSkillIds.has(resolved.id)) {
                  return {
                    ok: false as const,
                    skill,
                    error: {
                      code: "already_loaded" as const,
                      message: `Skill "@skill/${skill}" is already available in this chat. Follow its existing instructions without loading it again.`,
                    },
                  };
                }
                const skillBytes = skillsByteLength([resolved]);
                if (
                  loadedSkillCount >= MAX_CHAT_SKILLS ||
                  loadedSkillBytes + skillBytes > MAX_CHAT_SKILL_BYTES
                ) {
                  return {
                    ok: false as const,
                    skill,
                    error: {
                      code: "call_budget" as const,
                      message: `Skill loading is limited to ${MAX_CHAT_SKILLS} skills and ${MAX_CHAT_SKILL_BYTES / 1024} KiB of instructions per chat turn. Continue with the skills already loaded.`,
                    },
                  };
                }
                activeSkillIds.add(resolved.id);
                loadedSkillCount += 1;
                loadedSkillBytes += skillBytes;
                return {
                  ok: true as const,
                  skill: {
                    id: resolved.id,
                    name: resolved.name,
                    description: resolved.description,
                    instructions: resolved.instructions,
                  },
                };
              } catch (error) {
                if (error instanceof SkillMentionError) {
                  return {
                    ok: false as const,
                    skill,
                    error: {
                      code: "unavailable" as const,
                      message: error.message,
                    },
                  };
                }
                throw error;
              }
            },
          },
        }
      : {}),
    ...(workflowCatalog.length > 0
      ? {
          workflows: {
            catalog: workflowCatalog,
            execute: async ({ workflowId, prompt }: { workflowId: string; prompt: string }) => {
              const description = prompt.trim();
              if (description.length > CHAT_PROMPT_MAX_LENGTH) {
                throw new Error(
                  `Workflow task descriptions can be at most ${CHAT_PROMPT_MAX_LENGTH.toLocaleString()} characters.`,
                );
              }
              const created = await createTaskFromWorkflow({
                userWorkosId: context.user.workosUserId,
                workspaceId: context.workspace.id,
                mention: { id: workflowId },
                description,
              });
              after(
                generateWorkflowTaskTitle({
                  taskId: created.id,
                  userWorkosId: context.user.workosUserId,
                  workflowName: created.name,
                  description,
                  apiKey: gatewayApiKey,
                }).catch(() => undefined),
              );
              const attributes = {
                ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
                "goat.chat_session_id": turn.session.id,
                "goat.chat_message_id": turn.userMessageId,
                "goat.model": turn.session.model,
                "goat.task_id": created.id,
                "goat.workflow_id": workflowId,
              };
              chatSpan.setAttributes({
                ...attributes,
                "goat.task_started": true,
              });
              recordCounter(METRICS.chatTasksStartedTotal, 1, attributes);
              return {
                id: created.id,
                displayId: created.displayId,
                name: created.name,
                prompt: created.prompt,
              };
            },
          },
        }
      : {}),
    ...(actionCatalog.actions.length > 0
      ? {
          actions: {
            catalog: {
              sources: actionCatalog.providers.map((source) => ({
                ...source,
                kind: source.kind ?? "integration",
              })),
              actions: actionCatalog.actions.map((action) => ({
                id: action.id,
                source: action.provider,
                description: action.description,
                params: action.params,
                permissionMode: action.permissionMode,
              })),
            },
            ...(prelistedActionSourceIds.size > 0
              ? { prelistedSourceIds: [...prelistedActionSourceIds] }
              : {}),
            needsApproval: async (call) => {
              const spec = MANAGED_CAPABILITY_ACTIONS_BY_ID.get(call.action);
              if (!spec) return false;
              try {
                return await evaluateManagedCapabilityApproval({
                  spec,
                  params: call.params,
                  toolCallId: call.toolCallId,
                  workspaceId: context.workspace.id,
                  userWorkosId: context.user.workosUserId,
                  chatSessionId: turn.session.id,
                  turnState: capabilityTurnState,
                  signal: generationSignal,
                });
              } catch {
                return false;
              }
            },
            execute: (call) =>
              executeChatActionCall({
                catalog: actionCatalog,
                action: call.action,
                params: call.params,
                signal: generationSignal,
                currentDate,
                userTimezone: context.user.timezone?.trim() || "UTC",
                userWorkosId: context.user.workosUserId,
                workspaceId: context.workspace.id,
                chatSessionId: turn.session.id,
                toolCallId: call.toolCallId,
                capabilityTurnState,
                attributes: {
                  ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
                  "goat.chat_session_id": turn.session.id,
                  "goat.chat_message_id": turn.userMessageId,
                },
                chatSpan,
              }),
          },
        }
      : {}),
    ...(taskToolsEnabled
      ? {
          startTask: async (task) => {
            const created = await createTaskForUser({
              userWorkosId: context.user.workosUserId,
              workspaceId: context.workspace.id,
              brainRef: context.activeBrain?.id ?? null,
              ...(task.name ? { name: task.name } : {}),
              prompt: task.prompt,
              model: task.model,
              ...(task.engine ? { engine: task.engine } : {}),
            });
            const attributes = {
              ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
              "goat.chat_session_id": turn.session.id,
              "goat.chat_message_id": turn.userMessageId,
              "goat.model": turn.session.model,
              "goat.task_id": created.id,
            };
            chatSpan.setAttributes({
              ...attributes,
              "goat.task_started": true,
            });
            recordCounter(METRICS.chatTasksStartedTotal, 1, attributes);
            return {
              id: created.id,
              displayId: created.displayId,
              name: created.name,
              prompt: created.prompt,
            };
          },
          scheduleTask: async (schedule) => {
            const created = await createTaskScheduleForUser({
              userWorkosId: context.user.workosUserId,
              name: schedule.name,
              sourceDescription: schedule.sourceDescription ?? schedule.reason ?? "",
              cron: schedule.cron,
              timezone: schedule.timezone ?? context.user.timezone,
              prompt: schedule.prompt,
            });
            return {
              scheduleId: created.id,
              scheduleName: created.name,
              cron: created.cron,
              timezone: created.timezone,
              nextRunAt: created.nextRunAt.toISOString(),
              prompt: created.prompt,
              status: "scheduled",
            };
          },
          editTaskSchedule: async (edit) => {
            const target = resolveChatScheduleTarget(recurringSchedules, {
              ...(edit.scheduleId ? { scheduleId: edit.scheduleId } : {}),
              ...(edit.scheduleName ? { scheduleName: edit.scheduleName } : {}),
            });
            if (!target.ok) return target;

            const name = edit.name?.trim() || target.schedule.name;
            const cron = edit.cron?.trim() || target.schedule.cron;
            const timezone = edit.timezone?.trim() || target.schedule.timezone;
            const prompt = edit.prompt?.trim() || target.schedule.prompt;
            const scheduleTimingChanged = Boolean(edit.cron?.trim() || edit.timezone?.trim());
            const sourceDescription =
              edit.sourceDescription?.trim() ||
              (!scheduleTimingChanged ? target.schedule.sourceDescription : "") ||
              `${cron} - ${timezone}`;

            const result = await updateTaskScheduleForUser(
              context.user.workosUserId,
              target.schedule.id,
              {
                name,
                sourceDescription,
                cron,
                timezone,
                prompt,
              },
            );
            if (!result.ok) {
              return {
                ok: false,
                status: "invalid",
                error: result.error,
              } satisfies EditTaskScheduleToolOutput;
            }

            return {
              ok: true,
              scheduleId: result.schedule.id,
              scheduleName: result.schedule.name,
              cron: result.schedule.cron,
              timezone: result.schedule.timezone,
              nextRunAt: result.schedule.nextRunAt.toISOString(),
              status: "updated",
            };
          },
          deleteTaskSchedule: async (input) => {
            const target = resolveChatScheduleTarget(recurringSchedules, input);
            if (!target.ok) return target;

            const result = await deleteTaskScheduleForUser(
              context.user.workosUserId,
              target.schedule.id,
            );
            if (!result.ok) {
              return {
                ok: false,
                status: "invalid",
                error: result.error,
              } satisfies DeleteTaskScheduleToolOutput;
            }
            return {
              ok: true,
              scheduleId: target.schedule.id,
              scheduleName: target.schedule.name,
              status: "deleted",
            };
          },
        }
      : {}),
  });

  let debugTrace: ChatMessageDebugTrace = createOpenCompanyChatDebugTrace({
    model: turn.session.model,
  });
  let assistantPersisted = false;
  let assistantPersistPromise: Promise<void> | null = null;
  const persistFallbackAssistantMessage = (error: unknown, finishReason: string) => {
    if (assistantPersisted || assistantPersistPromise) return assistantPersistPromise;
    const startedTask = toolContext.getStartedTask();
    if (!startedTask && !toolContext.hasVisibleToolActivity()) return null;

    const fallbackTrace = {
      ...debugTrace,
      durationMs: elapsedChatDurationMs(),
      ...(generationSignal.aborted ? { aborted: true } : {}),
      error: error instanceof Error ? error.message : "Goat chat stream ended before completion.",
      finishReason,
    };
    finishChatTelemetry(
      generationSignal.aborted ? "aborted" : "failure",
      {
        "goat.chat_session_id": turn.session.id,
        "goat.chat_message_id": turn.userMessageId,
        "goat.model": turn.session.model,
        "goat.task_started": Boolean(startedTask),
        "goat.task_id": startedTask?.id,
      },
      error,
    );
    assistantPersistPromise = Promise.resolve(
      persistChatAssistantMessage(
        {
          sessionId: turn.session.id,
          content: startedTask
            ? normalizeAgentText("", startedTask)
            : "Goat stopped before it could finish.",
          taskId: startedTask?.id ?? null,
          debugTrace: fallbackTrace,
        },
        store,
      ),
    )
      .then(() => {
        assistantPersisted = true;
      })
      .catch((persistError) => {
        console.warn("Goat chat fallback persistence failed.", {
          event: "goat.chat_fallback_persist_failed",
          session_id: turn.session.id,
          error: persistError,
        });
      });
    return assistantPersistPromise;
  };
  // No request-abort fallback here: aborts flow through the UI message stream
  // as an abort chunk, so the stream onFinish below persists the real partial
  // response (text included) instead of a placeholder.
  const gateway = createGateway({ apiKey: gatewayApiKey });
  const gatewayAttribution = createGatewayAttribution({
    userWorkosId: context.user.workosUserId,
    feature: "chat",
    chatSessionId: turn.session.id,
    ...(context.activeBrain ? { brainRef: context.activeBrain.id } : {}),
  });
  const result = streamText({
    model: gateway(turn.session.model),
    system: createOpenCompanyChatSystemPrompt({
      currentDate,
      userContext: {
        email: context.user.email,
        firstName: context.user.firstName,
        lastName: context.user.lastName,
        timezone: context.user.timezone,
      },
      webFetchEnabled: Boolean(exaApiKey),
      webSearchEnabled: Boolean(exaApiKey),
      activeBrain: context.activeBrain
        ? {
            name: context.activeBrain.name,
            workspaceName: context.workspace.name,
          }
        : null,
      brainCaptureEnabled,
      browserToolsEnabled: Boolean(browserToolSession),
      skillsAvailable: skillCatalog.length > 0,
      workflows: workflowCatalog,
      taskToolsEnabled,
      scheduleToolsEnabled: taskToolsEnabled,
      recurringSchedules,
      ...(actionCatalog.providers.length > 0
        ? {
            actionSources: actionCatalog.providers.map((source) => ({
              ...source,
              kind: source.kind ?? "integration",
            })),
            connectedIntegrations: actionCatalog.providers.filter(
              // Stripe is live operational finance data, not durable company
              // knowledge to survey or capture during automatic Brain fill.
              (source) => source.kind !== "managed" && source.id !== "stripe",
            ),
          }
        : {}),
    }),
    messages: await convertToModelMessages(
      await hydrateChatAttachmentParts({
        // Match native skill runtimes: the full skill enters history on its activation message and
        // remains available on every later turn in this chat without re-inlining it elsewhere.
        uiMessages: turn.messages.map((uiMessage) => {
          const activatedSkills = skillsByActivationMessageId.get(uiMessage.id) ?? [];
          return activatedSkills.length > 0
            ? replaceChatUiMessageText(
                uiMessage,
                attachSkillsToPrompt(textFromChatUiMessage(uiMessage), activatedSkills),
              )
            : uiMessage;
        }),
        storedMessages: turn.storedMessages,
        modelId: turn.session.model,
      }),
      { ignoreIncompleteToolCalls: true },
    ),
    stopWhen: stepCountIs(maxChatSteps),
    // Providers deliver tokens in bursts; re-chunk to word-level with a small
    // delay so streamed text reads as a steady flow instead of jumps.
    experimental_transform: smoothStream(),
    abortSignal: generationSignal,
    tools: toolContext.tools,
    prepareStep: ({ stepNumber }: { stepNumber: number }) =>
      prepareOpenCompanyChatStep({
        stepNumber,
        maxSteps: maxChatSteps,
        finalizeAfterApproval: turn.respondedApprovals.some(
          (approval) => !MANAGED_CAPABILITY_ACTIONS_BY_ID.has(approval.action),
        ),
      }),
    ...(toolContext.repairToolCall
      ? { experimental_repairToolCall: toolContext.repairToolCall }
      : {}),
    providerOptions: gatewayProviderOptions(
      gatewayAttribution,
      GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
    ),
    ...latitudeTelemetry({
      name: "chat-turn",
      feature: "chat",
      userId: context.user.workosUserId,
      sessionId: turn.session.id,
      metadata: {
        model: turn.session.model,
        workspaceId: context.workspace.id,
        userMessageId: turn.userMessageId,
        ...(context.activeBrain ? { brainRef: context.activeBrain.id } : {}),
      },
    }),
    async onFinish(event) {
      const finishReason = stringifyFinishReason(event.finishReason);
      await recordChatModelCost({
        model: turn.session.model,
        usage: event.totalUsage,
        workspaceId: context.workspace.id,
        userWorkosId: context.user.workosUserId,
        chatSessionId: turn.session.id,
        userMessageId: turn.userMessageId,
        // A continuation is a second debit for the same user message; suffix
        // the key so it is not deduped against the paused turn's debit.
        ...(turn.respondedApprovals.length > 0
          ? {
              idempotencyKeySuffix: `:approval:${turn.respondedApprovals[0]?.approvalId ?? "unknown"}`,
            }
          : {}),
      });
      debugTrace = createOpenCompanyChatDebugTrace({
        model: turn.session.model,
        steps: event.steps,
        ...(finishReason ? { finishReason } : {}),
      });
      await recordBrowserSandboxUsage();
    },
    onError(event) {
      finishChatTelemetry(
        "failure",
        {
          "goat.chat_session_id": turn.session.id,
          "goat.chat_message_id": turn.userMessageId,
          "goat.model": turn.session.model,
          "goat.task_started": Boolean(toolContext.getStartedTask()),
          "goat.task_id": toolContext.getStartedTask()?.id,
        },
        event.error,
      );
      debugTrace = createOpenCompanyChatDebugTrace({
        model: turn.session.model,
        error: event.error instanceof Error ? event.error.message : "Goat chat failed.",
      });
      after(recordBrowserSandboxUsage());
      void persistFallbackAssistantMessage(event.error, "error");
    },
  });

  // after() runs once the response has finished streaming, when the model
  // spans have ended; export them to Latitude before the function is frozen.
  after(() => flushLatitude());

  return result.toUIMessageStreamResponse<ChatUiMessage>({
    originalMessages: turn.messages,
    generateMessageId: newChatMessageId,
    messageMetadata: ({ part }) =>
      toStreamMessageMetadata(
        turn.session.id,
        turn.session.model,
        toolContext.getStartedTask(),
        part.type === "finish-step" ? chatContextTokensFromUsage(part.usage) : undefined,
      ),
    consumeSseStream({ stream }) {
      // This copy of the SSE stream keeps the turn alive independently of the
      // client connection: it drives generation and the onFinish persistence
      // below even when the browser disconnects mid-stream.
      if (!resumeEnabled) {
        after(stream.pipeTo(new WritableStream()).catch(() => undefined));
        return;
      }
      const streamId = newChatStreamId();
      activeStreamId = streamId;
      const streamContext = getChatStreamContext();
      after(
        (async () => {
          try {
            await setActiveChatStream(turn.session.id, streamId);
            stopWatcherCleanup = watchChatStop(streamId, () => stopController.abort());
            await streamContext.createNewResumableStream(streamId, () => stream);
          } catch (error) {
            console.warn("Goat chat resumable stream setup failed.", {
              event: "goat.chat_resumable_stream_failed",
              session_id: turn.session.id,
              error,
            });
            // Resume is unavailable, but persistence still needs the copy to
            // be drained to completion.
            await stream.pipeTo(new WritableStream()).catch(() => undefined);
          }
        })(),
      );
    },
    onError(error) {
      console.warn("Goat chat stream failed.", {
        event: "goat.chat_stream_failed",
        session_id: turn.session.id,
        error,
      });
      after(recordBrowserSandboxUsage());
      void persistFallbackAssistantMessage(error, "error");
      return "Goat could not answer that right now.";
    },
    onFinish: async ({ responseMessage, finishReason, isAborted }) => {
      releaseStreamCoordination();
      await recordBrowserSandboxUsage();
      if (assistantPersistPromise) await assistantPersistPromise;
      if (assistantPersisted) return;

      const startedTask = toolContext.getStartedTask();
      const responseParts = settleIncompleteToolCallsInStoredParts(responseMessage.parts)
        .parts as ChatUiMessage["parts"];
      const settledResponseMessage = { ...responseMessage, parts: responseParts };
      const rawContent = textFromChatUiMessage(settledResponseMessage);
      const hasAssistantParts = hasDisplayableAssistantParts(settledResponseMessage);
      if (isAborted && !rawContent && !startedTask && !hasAssistantParts) {
        finishChatTelemetry("aborted", {
          "goat.chat_session_id": turn.session.id,
          "goat.chat_message_id": turn.userMessageId,
          "goat.model": turn.session.model,
          "goat.task_started": false,
        });
        return;
      }

      const finishReasonText = stringifyFinishReason(finishReason);
      const responseMessageId = safeClientMessageId(responseMessage.id);
      const finalTrace = {
        ...debugTrace,
        durationMs: elapsedChatDurationMs(),
        ...(isAborted ? { aborted: true } : {}),
        ...(responseParts.length ? { uiMessageParts: responseParts } : {}),
        ...(finishReasonText ? { finishReason: finishReasonText } : {}),
      };
      const assistantMessageInput = {
        sessionId: turn.session.id,
        ...(responseMessageId ? { messageId: responseMessageId } : {}),
        content:
          isAborted && !rawContent && hasAssistantParts && !startedTask
            ? ""
            : normalizeAgentText(rawContent, startedTask),
        // A continuation upsert must not drop a task the paused turn already
        // linked to this message.
        taskId: startedTask?.id ?? turn.continuationTaskId ?? null,
        debugTrace: finalTrace,
      };
      try {
        await persistChatAssistantMessage(assistantMessageInput, store);
      } catch (error) {
        if (!responseMessageId) throw error;
        console.warn("Goat chat assistant persistence failed; retrying with a server id.", {
          event: "goat.chat_assistant_persist_retry",
          session_id: turn.session.id,
          error,
        });
        await persistChatAssistantMessage(
          {
            ...assistantMessageInput,
            messageId: null,
          },
          store,
        );
      }
      assistantPersisted = true;
      finishChatTelemetry(isAborted ? "aborted" : "success", {
        "goat.chat_session_id": turn.session.id,
        "goat.chat_message_id": turn.userMessageId,
        "goat.model": turn.session.model,
        "goat.task_started": Boolean(startedTask),
        "goat.task_id": startedTask?.id,
      });
    },
  });
}

function groupSessionSkillsByActivationMessage(skills: ChatSessionSkillSnapshot[]) {
  const grouped = new Map<
    string,
    Array<{
      id: string;
      name: string;
      description: string;
      instructions: string;
    }>
  >();
  for (const skill of skills) {
    const activated = grouped.get(skill.activatedMessageId) ?? [];
    activated.push({
      id: skill.skillId,
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
    });
    grouped.set(skill.activatedMessageId, activated);
  }
  return grouped;
}

async function executeChatWebFetch(input: {
  toolInput: WebFetchToolInput;
  apiKey: string;
  signal: AbortSignal;
  attributes: Record<string, string | number | boolean | null | undefined>;
  chatSpan: ReturnType<typeof startSpan>;
}): Promise<WebFetchToolOutput> {
  const baseAttributes = {
    ...input.attributes,
    "goat.web_fetch_provider": "exa",
    "goat.web_fetch_operation": "contents",
  };
  try {
    const output = await executeChatExaFetch(input);
    const attributes = {
      ...baseAttributes,
      "goat.outcome": "success",
      "goat.web_fetch_cost_usd_micros": output.costUsdMicros ?? 0,
    };
    input.chatSpan.setAttributes({
      "goat.web_fetch_used": true,
      "goat.web_fetch_cost_usd_micros": output.costUsdMicros ?? 0,
    });
    recordCounter(METRICS.chatWebFetchesTotal, 1, attributes);
    if (output.costUsdMicros) {
      recordCounter(METRICS.chatWebFetchCostUsdMicros, output.costUsdMicros, attributes);
    }
    return output;
  } catch (error) {
    input.chatSpan.setAttributes({
      "goat.web_fetch_used": true,
      "goat.web_fetch_failed": true,
    });
    recordCounter(METRICS.chatWebFetchesTotal, 1, {
      ...baseAttributes,
      "goat.outcome": "failure",
    });
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Web fetch failed.",
    };
  }
}

async function executeChatWebSearch(input: {
  toolInput: WebSearchToolInput;
  apiKey: string;
  signal: AbortSignal;
  currentDate: Date;
  attributes: Record<string, string | number | boolean | null | undefined>;
  chatSpan: ReturnType<typeof startSpan>;
}): Promise<WebSearchToolOutput> {
  const baseAttributes = {
    ...input.attributes,
    "goat.web_search_provider": "exa",
    "goat.web_search_operation": "search",
  };
  try {
    const output = await executeChatExaSearch(input);
    const attributes = {
      ...baseAttributes,
      "goat.outcome": "success",
      "goat.web_search_cost_usd_micros": output.costUsdMicros ?? 0,
      "goat.web_search_result_count": output.results.length,
    };
    input.chatSpan.setAttributes({
      "goat.web_search_used": true,
      "goat.web_search_cost_usd_micros": output.costUsdMicros ?? 0,
      "goat.web_search_result_count": output.results.length,
    });
    recordCounter(METRICS.chatWebSearchesTotal, 1, attributes);
    if (output.costUsdMicros) {
      recordCounter(METRICS.chatWebSearchCostUsdMicros, output.costUsdMicros, attributes);
    }
    return output;
  } catch (error) {
    const attributes = {
      ...baseAttributes,
      "goat.outcome": "failure",
    };
    input.chatSpan.setAttributes({
      "goat.web_search_used": true,
      "goat.web_search_failed": true,
    });
    recordCounter(METRICS.chatWebSearchesTotal, 1, attributes);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Web search failed.",
    };
  }
}

// Direct provider calls: no sub-agent LLM, so no worker cost recording — the
// only model usage in a turn is the main stream's own totalUsage.
async function executeChatActionCall(input: {
  catalog: ResolvedActionCatalog;
  action: string;
  params: Record<string, unknown>;
  signal: AbortSignal;
  currentDate: Date;
  userTimezone: string;
  userWorkosId: string;
  workspaceId: string;
  chatSessionId: string;
  toolCallId: string;
  capabilityTurnState: CapabilityTurnState;
  attributes: Record<string, string | number | boolean | null | undefined>;
  chatSpan: ReturnType<typeof startSpan>;
}): Promise<UseActionToolOutput> {
  const startedAt = performance.now();
  const provider = input.catalog.actions.find((entry) => entry.id === input.action)?.provider;
  // Created inside the chat-turn span's context so it nests as a child span.
  const actionSpan = input.chatSpan.runInContext(() =>
    startSpan(SPANS.chatActionCall, {
      ...input.attributes,
      "goat.action": input.action,
      ...(provider ? { "goat.action_provider": provider } : {}),
    }),
  );
  const metricAttributes = {
    "goat.action": input.action,
    ...(provider ? { "goat.action_provider": provider } : {}),
  };

  try {
    const result = await executeAction({
      catalog: input.catalog,
      actionId: input.action,
      params: input.params,
      userWorkosId: input.userWorkosId,
      workspaceId: input.workspaceId,
      chatSessionId: input.chatSessionId,
      toolCallId: input.toolCallId,
      capabilityTurnState: input.capabilityTurnState,
      signal: input.signal,
      currentDate: input.currentDate,
      userTimezone: input.userTimezone,
    });
    actionSpan.end({
      "goat.outcome": result.ok ? "success" : "failure",
      ...(result.ok ? {} : { "goat.action_error_code": result.error.code }),
    });
    recordCounter(METRICS.chatActionCallsTotal, 1, {
      ...metricAttributes,
      "goat.outcome": result.ok ? "success" : result.error.code,
    });
    recordHistogram(
      METRICS.chatActionCallDurationMs,
      Math.max(0, Math.round(performance.now() - startedAt)),
      metricAttributes,
    );
    return result;
  } catch (error) {
    // executeAction converts action failures into structured results;
    // reaching here means infrastructure broke (or the turn was aborted).
    // Still return a structured result so the turn survives.
    actionSpan.fail(error, metricAttributes);
    actionSpan.end({ "goat.outcome": "failure" });
    recordCounter(METRICS.chatActionCallsTotal, 1, {
      ...metricAttributes,
      "goat.outcome": "error",
    });
    logger.warn("Goat chat action call failed", {
      event: "goat.chat_action_call_failed",
      action: input.action,
      chat_session_id: input.chatSessionId,
      error,
    });
    return {
      ok: false,
      action: input.action,
      error: {
        code: "internal",
        message: `The ${input.action} call failed unexpectedly; suggest trying again.`,
      },
    };
  }
}

async function recordChatModelCost(input: {
  model: string;
  usage?: LanguageModelUsage;
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string;
  userMessageId: string;
  idempotencyKeySuffix?: string;
  stage?: "generation" | "routing";
}) {
  if (!input.usage) return;
  const usage = normalizeChatModelUsage(input.usage);
  const cost = calculateModelUsageCost({
    modelName: input.model,
    inputTokens: usage.inputTokens,
    inputNoCacheTokens: usage.inputNoCacheTokens,
    inputCacheReadTokens: usage.inputCacheReadTokens,
    inputCacheWriteTokens: usage.inputCacheWriteTokens,
    outputTokens: usage.outputTokens,
  });
  recordModelCost({
    costUsdMicros: cost.totalCostUsdMicros,
    attributes: {
      "goat.model": input.model,
      "goat.surface": "chat",
      "goat.stage": input.stage ?? "generation",
    },
  });
  await captureLlmUsageRecorded({
    distinctId: input.userWorkosId,
    workspaceId: input.workspaceId,
    surface: "chat",
    stage: input.stage ?? "generation",
    sessionId: input.chatSessionId,
    messageId: input.userMessageId,
    modelProvider: "vercel-ai-gateway",
    model: input.model,
    engine: "opencompany",
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
    billable: cost.billable,
  });
  // Usage-based chat: debit the turn's at-cost usage.
  // from the workspace credits. Unknown/variable-priced models compute to
  // billable=false and debit nothing. The user-message id dedupes stream
  // resume/replay paths. A debit failure must never fail the turn.
  if (!cost.billable) return;
  try {
    const debit = await recordCreditDebit({
      workspaceId: input.workspaceId,
      userWorkosId: input.userWorkosId,
      source: "chat_model_usage",
      idempotencyKey: `chat:${input.userMessageId}${input.idempotencyKeySuffix ?? ""}`,
      chatSessionId: input.chatSessionId,
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      costBasis: cost.costBasis,
    });
    if (debit.ok) {
      await captureModelSpendRecorded({
        userWorkosId: input.userWorkosId,
        workspaceId: input.workspaceId,
        billingSource: "chat_model_usage",
        surface: "chat",
        model: input.model,
        stage: input.stage ?? "generation",
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
    // Fire-and-forget: charge the saved card when the balance dropped below
    // the auto-refill threshold. The cron sweep covers runner-side debits.
    void maybeTriggerAutoRefill(input.workspaceId);
  } catch (error) {
    logger.warn("Goat chat credit debit failed", {
      event: "goat.chat_credit_debit_failed",
      workspace_id: input.workspaceId,
      chat_session_id: input.chatSessionId,
      error,
    });
  }
}

function normalizeChatModelUsage(usage: LanguageModelUsage) {
  const inputTokens = readUsageNumber(usage.inputTokens);
  const inputCacheReadTokens = readUsageNumber(
    usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens,
  );
  const inputCacheWriteTokens = readUsageNumber(usage.inputTokenDetails?.cacheWriteTokens);
  const inputNoCacheTokens =
    readUsageNumber(usage.inputTokenDetails?.noCacheTokens) ||
    Math.max(0, inputTokens - inputCacheReadTokens - inputCacheWriteTokens);
  const outputTokens = readUsageNumber(usage.outputTokens);
  const outputReasoningTokens = readUsageNumber(
    usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens,
  );
  const outputTextTokens =
    readUsageNumber(usage.outputTokenDetails?.textTokens) ||
    Math.max(0, outputTokens - outputReasoningTokens);
  return {
    inputTokens,
    inputNoCacheTokens,
    inputCacheReadTokens,
    inputCacheWriteTokens,
    outputTokens,
    outputTextTokens,
    outputReasoningTokens,
    totalTokens: readUsageNumber(usage.totalTokens) || inputTokens + outputTokens,
  };
}

function readUsageNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function resolveChatScheduleTarget(
  schedules: readonly TaskScheduleView[],
  input: { scheduleId?: string; scheduleName?: string },
):
  | { ok: true; schedule: TaskScheduleView }
  | {
      ok: false;
      error: string;
      status: "not_found" | "ambiguous" | "invalid";
    } {
  const scheduleId = input.scheduleId?.trim();
  if (scheduleId) {
    const schedule = schedules.find((candidate) => candidate.id === scheduleId);
    return schedule
      ? { ok: true, schedule }
      : { ok: false, status: "not_found", error: "Recurring task not found." };
  }

  const scheduleName = input.scheduleName?.trim();
  if (!scheduleName) {
    return {
      ok: false,
      status: "invalid",
      error: "Specify which recurring task to change.",
    };
  }

  const normalizedName = normalizeScheduleLookupText(scheduleName);
  const matches = schedules.filter(
    (schedule) => normalizeScheduleLookupText(schedule.name) === normalizedName,
  );
  if (matches.length === 1 && matches[0]) return { ok: true, schedule: matches[0] };
  if (matches.length > 1) {
    return {
      ok: false,
      status: "ambiguous",
      error: "Multiple recurring tasks matched that name. Ask which one to change.",
    };
  }
  return { ok: false, status: "not_found", error: "Recurring task not found." };
}

function normalizeScheduleLookupText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function toStreamMessageMetadata(
  sessionId: string,
  model: string,
  task: StartedTask | null,
  contextTokens?: number,
): ChatMessageMetadata {
  return {
    sessionId,
    model,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(task
      ? {
          taskId: task.id,
          task: {
            id: task.id,
            displayId: task.displayId,
            title: task.name,
          },
        }
      : {}),
  };
}

async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: ChatRequestBody } | { ok: false; error: string }> {
  try {
    const value = (await request.json()) as unknown;
    if (!isRecord(value)) return { ok: false, error: "Invalid chat request." };
    return { ok: true, value };
  } catch {
    return { ok: false, error: "Invalid chat request." };
  }
}

function parseUserMessage(value: unknown): ChatUiMessage | null {
  if (!isRecord(value) || value.role !== "user" || typeof value.id !== "string") return null;
  if (!Array.isArray(value.parts)) return null;
  return value as unknown as ChatUiMessage;
}

// The auto-resend after the user answers a tool-approval card carries the
// assistant message itself. Only its approval decisions are trusted — the
// continuation turn re-reads everything else from the stored copy.
function parseApprovalContinuationMessage(value: unknown): ChatUiMessage | null {
  if (!isRecord(value) || value.role !== "assistant" || typeof value.id !== "string") return null;
  if (!Array.isArray(value.parts)) return null;
  return value as unknown as ChatUiMessage;
}

function safeClientMessageId(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160) return null;
  return trimmed;
}

function brainToolCallId(value: unknown) {
  if (!isRecord(value)) return undefined;
  const direct = normalizedOptionalString(value.toolCallId);
  if (direct) return direct;
  if (!isRecord(value.toolCall)) return undefined;
  return (
    normalizedOptionalString(value.toolCall.toolCallId) ??
    normalizedOptionalString(value.toolCall.id)
  );
}

function hasDisplayableAssistantParts(message: Pick<ChatUiMessage, "parts">) {
  return message.parts.some((part) => {
    if (part.type === "text") return part.text.trim().length > 0;
    return isRecord(part) && isPersistableToolPartType(part.type);
  });
}

function isPersistableToolPartType(value: unknown) {
  return typeof value === "string" && (value === "dynamic-tool" || value.startsWith("tool-"));
}

function normalizedOptionalString(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

type ChatMentionEngine = Extract<HarnessEngine, "codex" | "claude_code">;

async function resolveConnectedChatMentionEngine(input: {
  engine: ChatMentionEngine;
  userWorkosId: string;
}): Promise<ChatMentionEngine | undefined> {
  if (input.engine === "codex") {
    return (await isCodexConnectedForUser(input.userWorkosId)) ? "codex" : undefined;
  }
  return (await isClaudeCodeConnectedForUser(input.userWorkosId)) ? "claude_code" : undefined;
}

function readChatMentionEngine(value: unknown): ChatMentionEngine | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (isCodexEngineMention(item)) return "codex";
    if (isClaudeCodeEngineMention(item)) return "claude_code";
  }
  return undefined;
}

function isCodexEngineMention(value: unknown) {
  return isRecord(value) && value.kind === "engine" && value.id === "codex";
}

function isClaudeCodeEngineMention(value: unknown) {
  return isRecord(value) && value.kind === "engine" && value.id === "claude";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
