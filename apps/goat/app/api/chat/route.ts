import { executeExaSearchRequest } from "@opencompany/agent-runtime";
import type { GoatChatMessageDebugTrace } from "@opencompany/db/goat-schema";
import {
  GOAT_METRICS,
  GOAT_SPANS,
  hashGoatUserId,
  recordGoatChatTurn,
  recordGoatCounter,
  startGoatSpan,
} from "@opencompany/goat-observability";
import { convertToModelMessages, createGateway, stepCountIs, streamText } from "ai";
import { type SubmitGoatAttachmentInput, validateGoatSubmitAttachments } from "@/lib/attachments";
import { currentGoatUser } from "@/lib/auth";
import { runGoatBrainToolForUser } from "@/lib/brain-cli";
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
import { hydrateGoatChatAttachmentsForModel } from "@/lib/chat-attachments";
import {
  type DeleteTaskScheduleToolOutput,
  type EditTaskScheduleToolOutput,
  type GoatChatMessageMetadata,
  type GoatChatUiMessage,
  textFromGoatChatUiMessage,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "@/lib/chat-ui";
import { validateGoatChatInput } from "@/lib/chat-validation";
import { isGoatCodexConnectedForUser } from "@/lib/codex-auth";
import {
  createGoatTaskScheduleForUser,
  deleteGoatTaskScheduleAction,
  type GoatTaskScheduleView,
  listCurrentUserGoatTaskSchedules,
  updateGoatTaskScheduleAction,
} from "@/lib/task-schedules";
import { createGoatTaskForUser } from "@/lib/tasks";

export const maxDuration = 60;
export const runtime = "nodejs";

type ChatRequestBody = {
  sessionId?: unknown;
  model?: unknown;
  message?: unknown;
  mentions?: unknown;
  attachments?: unknown;
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

  const parsed = validateGoatChatInput({
    prompt: textFromGoatChatUiMessage(message),
    model: body.value.model,
    sessionId: body.value.sessionId,
  });
  if (!parsed.ok) return new Response(parsed.error, { status: 400 });
  const attachments = readSubmitAttachments(body.value.attachments);
  if (!attachments.ok) return new Response(attachments.error, { status: 400 });
  const attachmentCheck = validateGoatSubmitAttachments({
    attachments: attachments.value,
    userWorkosId: context.user.workosUserId,
    modelName: parsed.value.model,
  });
  if (!attachmentCheck.ok) return new Response(attachmentCheck.error, { status: 400 });
  const mentionEngine = readGoatChatMentionEngine(body.value.mentions);
  const requestedEngine =
    mentionEngine === "codex" && (await isGoatCodexConnectedForUser(context.user.workosUserId))
      ? "codex"
      : undefined;

  const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!gatewayApiKey) {
    return new Response("Goat chat is not configured.", { status: 503 });
  }
  const exaApiKey = process.env.EXA_API_KEY?.trim();

  const store = createDbGoatChatStore();
  const recurringSchedules = await listCurrentUserGoatTaskSchedules();
  const startedAt = performance.now();
  const currentDate = new Date();
  const userIdHash = hashGoatUserId(context.user.workosUserId);
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
    const durationMs = Math.round(performance.now() - startedAt);
    const failureCategory =
      outcome === "failure" && error
        ? chatSpan.fail(error, attributes)
        : (attributes["goat.failure_category"] as string | undefined);
    const finalAttributes = {
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
  };

  let turn: Awaited<ReturnType<typeof createGoatChatUserTurn>>;
  try {
    turn = await createGoatChatUserTurn(
      {
        userWorkosId: context.user.workosUserId,
        prompt: parsed.value.prompt,
        model: parsed.value.model,
        sessionId: parsed.value.sessionId,
        messageId: safeClientMessageId(message.id),
        ...(attachments.value.length ? { attachments: attachments.value } : {}),
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

  const toolContext = createOpenCompanyChatToolContext({
    model: turn.session.model,
    latestUserMessage: parsed.value.prompt,
    ...(requestedEngine ? { requestedEngine } : {}),
    runBrainCli: (toolInput, toolExecutionContext) => {
      const toolCallId = goatBrainToolCallId(toolExecutionContext);
      return runGoatBrainToolForUser({
        userWorkosId: context.user.workosUserId,
        toolInput,
        gatewayApiKey,
        sourceRef: `goat-chat:${turn.userMessage.id}`,
        chatSessionId: turn.session.id,
        userMessageId: turn.userMessage.id,
        ...(toolCallId ? { toolCallId } : {}),
        signal: request.signal,
      });
    },
    ...(exaApiKey
      ? {
          webSearch: (toolInput) =>
            executeChatWebSearch({
              toolInput,
              apiKey: exaApiKey,
              signal: request.signal,
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
    startTask: async (task) => {
      const created = await createGoatTaskForUser({
        userWorkosId: context.user.workosUserId,
        ...(task.name ? { name: task.name } : {}),
        prompt: task.prompt,
        model: task.model,
        ...(task.engine ? { engine: task.engine } : {}),
        ...(attachments.value.length ? { attachments: attachments.value } : {}),
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
  });

  let debugTrace: GoatChatMessageDebugTrace = createOpenCompanyChatDebugTrace({
    model: turn.session.model,
  });
  const gateway = createGateway({ apiKey: gatewayApiKey });
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
      recurringSchedules,
    }),
    messages: await convertToModelMessages(
      await hydrateGoatChatAttachmentsForModel({
        messages: turn.messages,
        userWorkosId: context.user.workosUserId,
        blobToken: process.env.BLOB_READ_WRITE_TOKEN,
      }),
    ),
    stopWhen: stepCountIs(OPENCOMPANY_CHAT_MAX_STEPS),
    abortSignal: request.signal,
    tools: toolContext.tools,
    onFinish(event) {
      const finishReason = stringifyFinishReason(event.finishReason);
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
    },
  });

  return result.toUIMessageStreamResponse<GoatChatUiMessage>({
    originalMessages: turn.messages,
    generateMessageId: newGoatChatMessageId,
    messageMetadata: () => toStreamMessageMetadata(turn.session.id, toolContext.getStartedTask()),
    onError(error) {
      console.warn("Goat chat stream failed.", {
        event: "goat.chat_stream_failed",
        session_id: turn.session.id,
        error,
      });
      return "Goat could not answer that right now.";
    },
    onFinish: async ({ responseMessage, finishReason, isAborted }) => {
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
        ...(isAborted ? { aborted: true } : {}),
        ...(responseMessage.parts.length ? { uiMessageParts: responseMessage.parts } : {}),
        ...(finishReasonText ? { finishReason: finishReasonText } : {}),
      };
      await persistGoatChatAssistantMessage(
        {
          sessionId: turn.session.id,
          ...(responseMessageId ? { messageId: responseMessageId } : {}),
          content:
            isAborted && !rawContent && hasAssistantParts && !startedTask
              ? ""
              : normalizeAgentText(rawContent, startedTask),
          taskId: startedTask?.id ?? null,
          debugTrace: finalTrace,
        },
        store,
      );
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

function resolveChatScheduleTarget(
  schedules: readonly GoatTaskScheduleView[],
  input: { scheduleId?: string; scheduleName?: string },
):
  | { ok: true; schedule: GoatTaskScheduleView }
  | { ok: false; error: string; status: "not_found" | "ambiguous" | "invalid" } {
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

function readSubmitAttachments(
  value: unknown,
): { ok: true; value: SubmitGoatAttachmentInput[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: "Invalid attachments." };
  const attachments: SubmitGoatAttachmentInput[] = [];
  for (const item of value) {
    if (!isRecord(item)) return { ok: false, error: "Invalid attachments." };
    const blobPathname = normalizedOptionalString(item.blobPathname);
    const blobUrl = normalizedOptionalString(item.blobUrl);
    const mediaType = normalizedOptionalString(item.mediaType);
    const filename = normalizedOptionalString(item.filename);
    const sizeBytes =
      typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes) ? item.sizeBytes : null;
    if (!blobPathname || !blobUrl || !mediaType || !filename || sizeBytes === null) {
      return { ok: false, error: "Invalid attachments." };
    }
    attachments.push({ blobPathname, blobUrl, mediaType, filename, sizeBytes });
  }
  return { ok: true, value: attachments };
}

function isCodexEngineMention(value: unknown) {
  return isRecord(value) && value.kind === "engine" && value.id === "codex";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
