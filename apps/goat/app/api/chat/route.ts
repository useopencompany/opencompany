import { executeExaSearchRequest, modelSupportsAttachments } from "@opencompany/agent-runtime";
import { calculateModelUsageCost } from "@opencompany/billing";
import { isGoatCreditsEnforcementEnabled } from "@opencompany/db/goat-billing";
import { hasPositiveGoatCreditBalance, recordGoatCreditDebit } from "@opencompany/db/goat-credits";
import type { GoatChatMessageDebugTrace } from "@opencompany/db/goat-schema";
import {
  createGoatGatewayAttribution,
  GOAT_METRICS,
  GOAT_SPANS,
  goatGatewayProviderOptions,
  hashGoatUserId,
  recordGoatChatTurn,
  recordGoatCounter,
  recordGoatHistogram,
  recordGoatModelCost,
  startGoatSpan,
} from "@opencompany/goat-observability";
import { createLogger } from "@opencompany/observability";
import { captureStatsigServerEvent } from "@opencompany/statsig/server";
import {
  convertToModelMessages,
  createGateway,
  type LanguageModelUsage,
  smoothStream,
  stepCountIs,
  streamText,
} from "ai";
import { after } from "next/server";
import { isGoatChatActionsKilled, resolveGoatActionCatalog } from "@/lib/actions/catalog";
import { executeGoatAction } from "@/lib/actions/execute";
import type { GoatResolvedActionCatalog } from "@/lib/actions/types";
import { currentGoatUser } from "@/lib/auth";
import { maybeTriggerGoatAutoRefill } from "@/lib/billing/auto-refill";
import { captureToGoatBrainInbox } from "@/lib/brain-capture";
import { runGoatBrainToolForUser } from "@/lib/brain-cli";
import {
  activateAndListGoatChatSessionSkills,
  attachGoatBrainSkillsToPrompt,
  GoatBrainSkillMentionError,
  type GoatChatSessionSkillSnapshot,
  readGoatBrainSkillMentionRefs,
  resolveGoatBrainSkillMentions,
} from "@/lib/brain-skills";
import {
  createDbGoatChatStore,
  createGoatChatUserTurn,
  newGoatChatMessageId,
  persistGoatChatAssistantMessage,
} from "@/lib/chat";
import {
  createOpenCompanyChatDebugTrace,
  createOpenCompanyChatSystemPrompt,
  createOpenCompanyChatToolContext,
  normalizeAgentText,
  OPENCOMPANY_CHAT_MAX_STEPS,
  type StartedTask,
  stringifyFinishReason,
} from "@/lib/chat-agent";
import { saveChatAttachmentsToGoatBrain } from "@/lib/chat-attachment-capture";
import {
  extractGoatChatAttachmentTexts,
  hydrateGoatChatAttachmentParts,
  parseGoatChatAttachmentsInput,
} from "@/lib/chat-attachments";
import { parseOptimisticGoatChatSessionId } from "@/lib/chat-navigation";
import {
  clearActiveGoatChatStream,
  getGoatChatStreamContext,
  isGoatChatResumeEnabled,
  newGoatChatStreamId,
  setActiveGoatChatStream,
  watchGoatChatStop,
} from "@/lib/chat-streams";
import { generateGoatChatTitleForMessage } from "@/lib/chat-title";
import {
  type DeleteTaskScheduleToolOutput,
  type EditTaskScheduleToolOutput,
  type GoatChatMessageMetadata,
  type GoatChatUiMessage,
  replaceGoatChatUiMessageText,
  textFromGoatChatUiMessage,
  type UseActionToolOutput,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "@/lib/chat-ui";
import { GOAT_CHAT_OUT_OF_CREDITS_MESSAGE, validateGoatChatInput } from "@/lib/chat-validation";
import { isGoatCodexConnectedForUser } from "@/lib/codex-auth";
import {
  createGoatTaskScheduleForUser,
  deleteGoatTaskScheduleAction,
  type GoatTaskScheduleView,
  listCurrentUserGoatTaskSchedules,
  updateGoatTaskScheduleAction,
} from "@/lib/task-schedules";
import { createGoatTaskForUser } from "@/lib/tasks";

export const maxDuration = 240;
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
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });

  const body = await readJsonBody(request);
  if (!body.ok) return new Response(body.error, { status: 400 });

  const message = parseUserMessage(body.value.message);
  if (!message) {
    return new Response("Invalid chat message.", { status: 400 });
  }

  const parsedAttachments = parseGoatChatAttachmentsInput(
    message.metadata?.attachments,
    context.user.workosUserId,
  );
  if (!parsedAttachments.ok) return new Response(parsedAttachments.error, { status: 400 });
  const attachments = parsedAttachments.attachments;

  const parsed = validateGoatChatInput({
    prompt: textFromGoatChatUiMessage(message),
    model: body.value.model,
    sessionId: body.value.sessionId,
    hasAttachments: attachments.length > 0,
  });
  if (!parsed.ok) return new Response(parsed.error, { status: 400 });
  const parsedNewSessionId = parseOptimisticGoatChatSessionId(body.value.newSessionId);
  if (!parsedNewSessionId.ok) return new Response(parsedNewSessionId.error, { status: 400 });
  if (parsed.value.sessionId && parsedNewSessionId.sessionId) {
    return new Response("A chat request cannot continue and create a session at the same time.", {
      status: 400,
    });
  }

  const attachmentCapabilities = modelSupportsAttachments(parsed.value.model);
  if (
    attachments.some((attachment) => attachment.kind === "image") &&
    !attachmentCapabilities.images
  ) {
    return new Response("The selected model does not support image attachments.", { status: 400 });
  }
  if (attachments.some((attachment) => attachment.kind === "pdf") && !attachmentCapabilities.pdf) {
    return new Response("The selected model does not support PDF attachments.", { status: 400 });
  }

  const mentionEngine = readGoatChatMentionEngine(body.value.mentions);
  const requestedEngine =
    mentionEngine === "codex" && (await isGoatCodexConnectedForUser(context.user.workosUserId))
      ? "codex"
      : undefined;
  if (requestedEngine && attachments.length > 0) {
    return new Response("Attachments are not supported in engine chats yet.", {
      status: 400,
    });
  }

  const parsedSkillMentions = readGoatBrainSkillMentionRefs(
    message.metadata?.mentions ?? body.value.mentions,
  );
  if (!parsedSkillMentions.ok) {
    return new Response(parsedSkillMentions.error, { status: 400 });
  }
  let resolvedSkills;
  try {
    resolvedSkills = await resolveGoatBrainSkillMentions({
      activeBrainRef: context.activeBrain?.id ?? null,
      mentions: parsedSkillMentions.mentions,
    });
  } catch (error) {
    if (error instanceof GoatBrainSkillMentionError) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }
  const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!gatewayApiKey) {
    return new Response("Goat chat is not configured.", { status: 503 });
  }
  // Chat is usage-based on both plans: each turn debits the workspace's USD
  // credits, and a turn cannot start on an empty balance. Codex-engine turns
  // are exempt (the user's own Codex auth pays for those, not the gateway).
  if (!requestedEngine && isGoatCreditsEnforcementEnabled()) {
    const hasCredits = await hasPositiveGoatCreditBalance(context.workspace.id).catch((error) => {
      logger.warn("Goat chat credit balance check failed", {
        event: "goat.chat_credit_balance_check_failed",
        workspace_id: context.workspace.id,
        error,
      });
      // Fail open: a transient balance-read failure must not block chat.
      return true;
    });
    if (!hasCredits) {
      return new Response(GOAT_CHAT_OUT_OF_CREDITS_MESSAGE, { status: 402 });
    }
  }
  const exaApiKey = process.env.EXA_API_KEY?.trim();
  const canManageWorkspaceBrain = context.role === "admin";
  const brainCaptureEnabled = Boolean(context.activeBrain);
  const taskToolsEnabled = context.user.taskSpawningEnabled && canManageWorkspaceBrain;

  // Action catalog: resolved per request from real connection state. On by
  // default for everyone; the env kill switch disables it without a deploy,
  // and engine chats (Codex) never get chat actions.
  const actionsEnabled = !requestedEngine && !isGoatChatActionsKilled();
  const emptyCatalog: GoatResolvedActionCatalog = { providers: [], actions: [] };
  const actionCatalog = actionsEnabled
    ? await resolveGoatActionCatalog({
        userWorkosId: context.user.workosUserId,
        workspaceId: context.workspace.id,
      }).catch((error) => {
        logger.warn("Goat chat action catalog resolution failed", {
          event: "goat.chat_action_catalog_resolution_failed",
          error,
        });
        return emptyCatalog;
      })
    : emptyCatalog;

  const store = createDbGoatChatStore();
  const recurringSchedules = taskToolsEnabled ? await listCurrentUserGoatTaskSchedules() : [];
  const startedAt = performance.now();
  const currentDate = new Date();
  const userIdHash = hashGoatUserId(context.user.workosUserId);
  const elapsedChatDurationMs = () => Math.max(0, Math.round(performance.now() - startedAt));
  const chatSpan = startGoatSpan(GOAT_SPANS.chatTurn, {
    ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
    "goat.model": parsed.value.model,
    "goat.task_started": false,
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
      "goat.model": parsed.value.model,
      "goat.outcome": outcome,
      ...(failureCategory ? { "goat.failure_category": failureCategory } : {}),
      ...attributes,
    };
    chatSpan.end(finalAttributes);
    recordGoatChatTurn({
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

  let turn: Awaited<ReturnType<typeof createGoatChatUserTurn>>;
  try {
    // Extract docx/xlsx text once at submit time; every later turn reads the
    // stored text instead of re-downloading the blob.
    const attachmentTexts =
      attachments.length > 0 ? await extractGoatChatAttachmentTexts(attachments) : null;
    turn = await createGoatChatUserTurn(
      {
        userWorkosId: context.user.workosUserId,
        prompt: parsed.value.prompt,
        model: parsed.value.model,
        sessionId: parsed.value.sessionId,
        newSessionId: parsedNewSessionId.sessionId,
        messageId: safeClientMessageId(message.id),
        attachments: attachments.length > 0 ? attachments : null,
        attachmentTexts,
      },
      store,
    );
    chatSpan.setAttributes({
      "goat.chat_session_id": turn.session.id,
      "goat.chat_message_id": turn.userMessage.id,
      "goat.model": turn.session.model,
    });
  } catch (error) {
    finishChatTelemetry("failure", {}, error);
    throw error;
  }
  let sessionSkills: GoatChatSessionSkillSnapshot[];
  try {
    sessionSkills = await activateAndListGoatChatSessionSkills({
      chatSessionId: turn.session.id,
      activatedMessageId: turn.userMessage.id,
      brainRef: context.activeBrain?.id ?? "",
      skills: resolvedSkills,
    });
  } catch (error) {
    finishChatTelemetry("failure", {}, error);
    throw error;
  }
  const skillsByActivationMessageId = groupSessionSkillsByActivationMessage(sessionSkills);
  after(
    generateGoatChatTitleForMessage({
      sessionId: turn.session.id,
      messageId: turn.userMessage.id,
      apiKey: gatewayApiKey,
    }).catch(() => undefined),
  );
  if (turn.sessionCreated) {
    after(
      captureStatsigServerEvent("chat_started", context.user.workosUserId, {
        user_id: context.user.workosUserId,
        workspace_id: context.workspace.id,
        session_id: turn.session.id,
      }),
    );
  }
  // Fires on every user turn (new chats and follow-ups). `is_first_message` lets the PM
  // segment new conversations from continued ones, while the raw count measures engagement
  // volume and per-session grouping gives conversation depth.
  after(
    captureStatsigServerEvent("chat_message_sent", context.user.workosUserId, {
      user_id: context.user.workosUserId,
      workspace_id: context.workspace.id,
      session_id: turn.session.id,
      is_first_message: turn.sessionCreated,
      model: turn.session.model,
      message_length: parsed.value.prompt.length,
    }),
  );

  // With resumable streams, a client disconnect (refresh, tab close, stop())
  // is just a dropped connection: generation keeps running and the client can
  // reattach. Explicit stops arrive via the stop endpoint, which aborts this
  // controller through the Redis stop signal. Without Redis, the request
  // signal keeps its old meaning: disconnect cancels generation.
  const resumeEnabled = isGoatChatResumeEnabled();
  const stopController = new AbortController();
  const generationSignal = resumeEnabled ? stopController.signal : request.signal;
  let stopWatcherCleanup: (() => void) | null = null;
  let activeStreamId: string | null = null;
  const releaseStreamCoordination = () => {
    stopWatcherCleanup?.();
    stopWatcherCleanup = null;
    if (activeStreamId) {
      void clearActiveGoatChatStream(turn.session.id, activeStreamId);
      activeStreamId = null;
    }
  };

  const toolContext = createOpenCompanyChatToolContext({
    model: turn.session.model,
    latestUserMessage: parsed.value.prompt,
    ...(requestedEngine ? { requestedEngine } : {}),
    // goat_brain is read-only for everyone (recall/inspect). The only write path
    // in chat is save_to_brain, which is available to every workspace member
    // with an active brain and enqueues the durable ingestion agent.
    runBrainCli: (toolInput, toolExecutionContext) => {
      const toolCallId = goatBrainToolCallId(toolExecutionContext);
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
      return runGoatBrainToolForUser({
        brainRef: activeBrain.id,
        userWorkosId: context.user.workosUserId,
        toolInput,
        gatewayApiKey,
        sourceRef: `goat-chat:${turn.userMessage.id}`,
        chatSessionId: turn.session.id,
        userMessageId: turn.userMessage.id,
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
              return saveChatAttachmentsToGoatBrain({
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
            const captured = await captureToGoatBrainInbox({
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
                itemId: turn.userMessage.id,
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
          webSearch: (toolInput) =>
            executeChatWebSearch({
              toolInput,
              apiKey: exaApiKey,
              signal: generationSignal,
              currentDate,
              attributes: {
                ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
                "goat.chat_session_id": turn.session.id,
                "goat.chat_message_id": turn.userMessage.id,
                "goat.model": turn.session.model,
              },
              chatSpan,
            }),
        }
      : {}),
    ...(actionCatalog.actions.length > 0
      ? {
          actions: {
            catalog: {
              providers: actionCatalog.providers,
              actions: actionCatalog.actions.map((action) => ({
                id: action.id,
                provider: action.provider,
                description: action.description,
                params: action.params,
              })),
            },
            execute: (call) =>
              executeChatActionCall({
                catalog: actionCatalog,
                action: call.action,
                params: call.params,
                signal: generationSignal,
                currentDate,
                userWorkosId: context.user.workosUserId,
                chatSessionId: turn.session.id,
                attributes: {
                  ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
                  "goat.chat_session_id": turn.session.id,
                  "goat.chat_message_id": turn.userMessage.id,
                },
                chatSpan,
              }),
          },
        }
      : {}),
    ...(taskToolsEnabled
      ? {
          startTask: async (task) => {
            const created = await createGoatTaskForUser({
              userWorkosId: context.user.workosUserId,
              ...(task.name ? { name: task.name } : {}),
              prompt: task.prompt,
              model: task.model,
              ...(task.engine ? { engine: task.engine } : {}),
            });
            const attributes = {
              ...(userIdHash ? { "goat.user_id_hash": userIdHash } : {}),
              "goat.chat_session_id": turn.session.id,
              "goat.chat_message_id": turn.userMessage.id,
              "goat.model": turn.session.model,
              "goat.task_id": created.id,
            };
            chatSpan.setAttributes({
              ...attributes,
              "goat.task_started": true,
            });
            recordGoatCounter(GOAT_METRICS.chatTasksStartedTotal, 1, attributes);
            return {
              id: created.id,
              displayId: created.displayId,
              name: created.name,
              prompt: created.prompt,
            };
          },
          scheduleTask: async (schedule) => {
            const created = await createGoatTaskScheduleForUser({
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

            const result = await updateGoatTaskScheduleAction(target.schedule.id, {
              name,
              sourceDescription,
              cron,
              timezone,
              prompt,
            });
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

            const result = await deleteGoatTaskScheduleAction(target.schedule.id);
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

  let debugTrace: GoatChatMessageDebugTrace = createOpenCompanyChatDebugTrace({
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
        "goat.chat_message_id": turn.userMessage.id,
        "goat.model": turn.session.model,
        "goat.task_started": Boolean(startedTask),
        "goat.task_id": startedTask?.id,
      },
      error,
    );
    assistantPersistPromise = Promise.resolve(
      persistGoatChatAssistantMessage(
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
  const gatewayAttribution = createGoatGatewayAttribution({
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
      webSearchEnabled: Boolean(exaApiKey),
      activeBrain: context.activeBrain
        ? {
            name: context.activeBrain.name,
            workspaceName: context.workspace.name,
          }
        : null,
      brainCaptureEnabled,
      taskToolsEnabled,
      scheduleToolsEnabled: taskToolsEnabled,
      recurringSchedules,
      ...(actionCatalog.providers.length > 0
        ? { connectedIntegrations: actionCatalog.providers }
        : {}),
    }),
    messages: await convertToModelMessages(
      await hydrateGoatChatAttachmentParts({
        // Match native skill runtimes: the full skill enters history on its activation message and
        // remains available on every later turn in this chat without re-inlining it elsewhere.
        uiMessages: turn.messages.map((uiMessage) => {
          const activatedSkills = skillsByActivationMessageId.get(uiMessage.id) ?? [];
          return activatedSkills.length > 0
            ? replaceGoatChatUiMessageText(
                uiMessage,
                attachGoatBrainSkillsToPrompt(
                  textFromGoatChatUiMessage(uiMessage),
                  activatedSkills,
                ),
              )
            : uiMessage;
        }),
        storedMessages: turn.storedMessages,
        modelId: turn.session.model,
      }),
    ),
    stopWhen: stepCountIs(OPENCOMPANY_CHAT_MAX_STEPS),
    // Providers deliver tokens in bursts; re-chunk to word-level with a small
    // delay so streamed text reads as a steady flow instead of jumps.
    experimental_transform: smoothStream(),
    abortSignal: generationSignal,
    tools: toolContext.tools,
    providerOptions: goatGatewayProviderOptions(gatewayAttribution),
    async onFinish(event) {
      const finishReason = stringifyFinishReason(event.finishReason);
      await recordChatModelCost({
        model: turn.session.model,
        usage: event.totalUsage,
        workspaceId: context.workspace.id,
        userWorkosId: context.user.workosUserId,
        chatSessionId: turn.session.id,
        userMessageId: turn.userMessage.id,
      });
      debugTrace = createOpenCompanyChatDebugTrace({
        model: turn.session.model,
        steps: event.steps,
        ...(finishReason ? { finishReason } : {}),
      });
    },
    onError(event) {
      finishChatTelemetry(
        "failure",
        {
          "goat.chat_session_id": turn.session.id,
          "goat.chat_message_id": turn.userMessage.id,
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
      void persistFallbackAssistantMessage(event.error, "error");
    },
  });

  return result.toUIMessageStreamResponse<GoatChatUiMessage>({
    originalMessages: turn.messages,
    generateMessageId: newGoatChatMessageId,
    messageMetadata: () => toStreamMessageMetadata(turn.session.id, toolContext.getStartedTask()),
    consumeSseStream({ stream }) {
      // This copy of the SSE stream keeps the turn alive independently of the
      // client connection: it drives generation and the onFinish persistence
      // below even when the browser disconnects mid-stream.
      if (!resumeEnabled) {
        after(stream.pipeTo(new WritableStream()).catch(() => undefined));
        return;
      }
      const streamId = newGoatChatStreamId();
      activeStreamId = streamId;
      const streamContext = getGoatChatStreamContext();
      after(
        (async () => {
          try {
            await setActiveGoatChatStream(turn.session.id, streamId);
            stopWatcherCleanup = watchGoatChatStop(streamId, () => stopController.abort());
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
      void persistFallbackAssistantMessage(error, "error");
      return "Goat could not answer that right now.";
    },
    onFinish: async ({ responseMessage, finishReason, isAborted }) => {
      releaseStreamCoordination();
      if (assistantPersistPromise) await assistantPersistPromise;
      if (assistantPersisted) return;

      const startedTask = toolContext.getStartedTask();
      const rawContent = textFromGoatChatUiMessage(responseMessage);
      const hasAssistantParts = hasDisplayableAssistantParts(responseMessage);
      if (isAborted && !rawContent && !startedTask && !hasAssistantParts) {
        finishChatTelemetry("aborted", {
          "goat.chat_session_id": turn.session.id,
          "goat.chat_message_id": turn.userMessage.id,
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
        ...(responseMessage.parts.length ? { uiMessageParts: responseMessage.parts } : {}),
        ...(finishReasonText ? { finishReason: finishReasonText } : {}),
      };
      const assistantMessageInput = {
        sessionId: turn.session.id,
        ...(responseMessageId ? { messageId: responseMessageId } : {}),
        content:
          isAborted && !rawContent && hasAssistantParts && !startedTask
            ? ""
            : normalizeAgentText(rawContent, startedTask),
        taskId: startedTask?.id ?? null,
        debugTrace: finalTrace,
      };
      try {
        await persistGoatChatAssistantMessage(assistantMessageInput, store);
      } catch (error) {
        if (!responseMessageId) throw error;
        console.warn("Goat chat assistant persistence failed; retrying with a server id.", {
          event: "goat.chat_assistant_persist_retry",
          session_id: turn.session.id,
          error,
        });
        await persistGoatChatAssistantMessage(
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
        "goat.chat_message_id": turn.userMessage.id,
        "goat.model": turn.session.model,
        "goat.task_started": Boolean(startedTask),
        "goat.task_id": startedTask?.id,
      });
    },
  });
}

function groupSessionSkillsByActivationMessage(skills: GoatChatSessionSkillSnapshot[]) {
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

async function executeChatWebSearch(input: {
  toolInput: WebSearchToolInput;
  apiKey: string;
  signal: AbortSignal;
  currentDate: Date;
  attributes: Record<string, string | number | boolean | null | undefined>;
  chatSpan: ReturnType<typeof startGoatSpan>;
}): Promise<WebSearchToolOutput> {
  const baseAttributes = {
    ...input.attributes,
    "goat.web_search_provider": "exa",
    "goat.web_search_operation": "search",
  };
  try {
    const output = await executeGoatChatExaSearch(input);
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
    recordGoatCounter(GOAT_METRICS.chatWebSearchesTotal, 1, attributes);
    if (output.costUsdMicros) {
      recordGoatCounter(GOAT_METRICS.chatWebSearchCostUsdMicros, output.costUsdMicros, attributes);
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
    recordGoatCounter(GOAT_METRICS.chatWebSearchesTotal, 1, attributes);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Web search failed.",
    };
  }
}

// Direct provider calls: no sub-agent LLM, so no worker cost recording — the
// only model usage in a turn is the main stream's own totalUsage.
async function executeChatActionCall(input: {
  catalog: GoatResolvedActionCatalog;
  action: string;
  params: Record<string, unknown>;
  signal: AbortSignal;
  currentDate: Date;
  userWorkosId: string;
  chatSessionId: string;
  attributes: Record<string, string | number | boolean | null | undefined>;
  chatSpan: ReturnType<typeof startGoatSpan>;
}): Promise<UseActionToolOutput> {
  const startedAt = performance.now();
  const provider = input.catalog.actions.find((entry) => entry.id === input.action)?.provider;
  // Created inside the chat-turn span's context so it nests as a child span.
  const actionSpan = input.chatSpan.runInContext(() =>
    startGoatSpan(GOAT_SPANS.chatActionCall, {
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
    const result = await executeGoatAction({
      catalog: input.catalog,
      actionId: input.action,
      params: input.params,
      userWorkosId: input.userWorkosId,
      signal: input.signal,
      currentDate: input.currentDate,
    });
    actionSpan.end({
      "goat.outcome": result.ok ? "success" : "failure",
      ...(result.ok ? {} : { "goat.action_error_code": result.error.code }),
    });
    recordGoatCounter(GOAT_METRICS.chatActionCallsTotal, 1, {
      ...metricAttributes,
      "goat.outcome": result.ok ? "success" : result.error.code,
    });
    recordGoatHistogram(
      GOAT_METRICS.chatActionCallDurationMs,
      Math.max(0, Math.round(performance.now() - startedAt)),
      metricAttributes,
    );
    return result;
  } catch (error) {
    // executeGoatAction converts action failures into structured results;
    // reaching here means infrastructure broke (or the turn was aborted).
    // Still return a structured result so the turn survives.
    actionSpan.fail(error, metricAttributes);
    actionSpan.end({ "goat.outcome": "failure" });
    recordGoatCounter(GOAT_METRICS.chatActionCallsTotal, 1, {
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

async function executeGoatChatExaSearch(input: {
  toolInput: WebSearchToolInput;
  apiKey: string;
  signal: AbortSignal;
  currentDate: Date;
}): Promise<Extract<WebSearchToolOutput, { ok: true }>> {
  const startPublishedDate = recencyStartPublishedDate(
    input.toolInput.recencyDays,
    input.currentDate,
  );
  const search = await executeExaSearchRequest({
    apiKey: input.apiKey,
    args: {
      query: input.toolInput.query,
      type: "fast",
      numResults: 5,
      ...(startPublishedDate ? { startPublishedDate } : {}),
    },
    signal: input.signal,
    defaults: { type: "fast", numResults: 5 },
  });

  return {
    ok: true,
    query: input.toolInput.query,
    searchedAt: input.currentDate.toISOString(),
    results: search.output.results.map((result) => ({
      ...(result.title ? { title: result.title } : {}),
      ...(result.url ? { url: result.url } : {}),
      ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
      ...(result.author ? { author: result.author } : {}),
      highlights: result.highlights ?? [],
    })),
    ...(search.output.requestId ? { requestId: search.output.requestId } : {}),
    costUsdMicros: search.usage.costUsdMicros,
  };
}

function recencyStartPublishedDate(recencyDays: WebSearchToolInput["recencyDays"], now: Date) {
  if (recencyDays !== 7 && recencyDays !== 30 && recencyDays !== 90) return undefined;
  return new Date(now.getTime() - recencyDays * 24 * 60 * 60 * 1000).toISOString();
}

async function recordChatModelCost(input: {
  model: string;
  usage?: LanguageModelUsage;
  workspaceId: string;
  userWorkosId: string;
  chatSessionId: string;
  userMessageId: string;
}) {
  if (!input.usage) return;
  const cost = calculateModelUsageCost({
    modelName: input.model,
    inputTokens: readUsageNumber(input.usage.inputTokens),
    inputNoCacheTokens: readUsageNumber(input.usage.inputTokenDetails?.noCacheTokens),
    inputCacheReadTokens: readUsageNumber(input.usage.inputTokenDetails?.cacheReadTokens),
    inputCacheWriteTokens: readUsageNumber(input.usage.inputTokenDetails?.cacheWriteTokens),
    outputTokens: readUsageNumber(input.usage.outputTokens),
  });
  recordGoatModelCost({
    costUsdMicros: cost.totalCostUsdMicros,
    attributes: {
      "goat.model": input.model,
      "goat.surface": "chat",
    },
  });
  // Usage-based chat: debit the turn's total cost (provider + platform fee)
  // from the workspace credits. Unknown/variable-priced models compute to
  // billable=false and debit nothing. The user-message id dedupes stream
  // resume/replay paths. A debit failure must never fail the turn.
  if (!cost.billable) return;
  try {
    await recordGoatCreditDebit({
      workspaceId: input.workspaceId,
      userWorkosId: input.userWorkosId,
      source: "chat_model_usage",
      idempotencyKey: `chat:${input.userMessageId}`,
      chatSessionId: input.chatSessionId,
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      costBasis: cost.costBasis,
    });
    // Fire-and-forget: charge the saved card when the balance dropped below
    // the auto-refill threshold. The cron sweep covers runner-side debits.
    void maybeTriggerGoatAutoRefill(input.workspaceId);
  } catch (error) {
    logger.warn("Goat chat credit debit failed", {
      event: "goat.chat_credit_debit_failed",
      workspace_id: input.workspaceId,
      chat_session_id: input.chatSessionId,
      error,
    });
  }
}

function readUsageNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function resolveChatScheduleTarget(
  schedules: readonly GoatTaskScheduleView[],
  input: { scheduleId?: string; scheduleName?: string },
):
  | { ok: true; schedule: GoatTaskScheduleView }
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
  task: StartedTask | null,
): GoatChatMessageMetadata {
  return {
    sessionId,
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

function parseUserMessage(value: unknown): GoatChatUiMessage | null {
  if (!isRecord(value) || value.role !== "user" || typeof value.id !== "string") return null;
  if (!Array.isArray(value.parts)) return null;
  return value as unknown as GoatChatUiMessage;
}

function safeClientMessageId(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160) return null;
  return trimmed;
}

function goatBrainToolCallId(value: unknown) {
  if (!isRecord(value)) return undefined;
  const direct = normalizedOptionalString(value.toolCallId);
  if (direct) return direct;
  if (!isRecord(value.toolCall)) return undefined;
  return (
    normalizedOptionalString(value.toolCall.toolCallId) ??
    normalizedOptionalString(value.toolCall.id)
  );
}

function hasDisplayableAssistantParts(message: Pick<GoatChatUiMessage, "parts">) {
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

function readGoatChatMentionEngine(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.some((item) => isCodexEngineMention(item)) ? "codex" : undefined;
}

function isCodexEngineMention(value: unknown) {
  return isRecord(value) && value.kind === "engine" && value.id === "codex";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
