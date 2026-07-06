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
  type StartedTask,
  stringifyFinishReason,
} from "@/lib/chat-agent";
import {
  type GoatChatMessageMetadata,
  type GoatChatUiMessage,
  textFromGoatChatUiMessage,
  type WebSearchToolInput,
  type WebSearchToolOutput,
} from "@/lib/chat-ui";
import { validateGoatChatInput } from "@/lib/chat-validation";
import { createGoatTaskForUser } from "@/lib/tasks";

export const maxDuration = 60;
export const runtime = "nodejs";

type ChatRequestBody = {
  sessionId?: unknown;
  model?: unknown;
  message?: unknown;
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

  const gatewayApiKey = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!gatewayApiKey) {
    return new Response("Goat chat is not configured.", { status: 503 });
  }
  const exaApiKey = process.env.EXA_API_KEY?.trim();

  const store = createDbGoatChatStore();
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
  });

  let debugTrace: GoatChatMessageDebugTrace = createOpenCompanyChatDebugTrace({
    model: turn.session.model,
  });
  const gateway = createGateway({ apiKey: gatewayApiKey });
  const result = streamText({
    model: gateway(turn.session.model),
    system: createOpenCompanyChatSystemPrompt({
      currentDate,
      webSearchEnabled: Boolean(exaApiKey),
    }),
    messages: await convertToModelMessages(turn.messages),
    stopWhen: stepCountIs(3),
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
      if (isAborted && !rawContent && !startedTask) {
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
        ...(responseMessage.parts.length ? { uiMessageParts: responseMessage.parts } : {}),
        ...(finishReasonText ? { finishReason: finishReasonText } : {}),
      };
      await persistGoatChatAssistantMessage(
        {
          sessionId: turn.session.id,
          ...(responseMessageId ? { messageId: responseMessageId } : {}),
          content: normalizeAgentText(rawContent, startedTask),
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

function toStreamMessageMetadata(
  sessionId: string,
  task: StartedTask | null,
): GoatChatMessageMetadata {
  return {
    sessionId,
    ...(task
      ? {
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

function normalizedOptionalString(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
