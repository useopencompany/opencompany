import type { GoatChatMessageDebugTrace } from "@opencompany/db/goat-schema";
import { convertToModelMessages, createGateway, stepCountIs, streamText } from "ai";
import { currentGoatUser } from "@/lib/auth";
import {
  createDbGoatChatStore,
  createGoatChatUserTurn,
  newGoatChatMessageId,
  persistGoatChatAssistantMessage,
} from "@/lib/chat";
import {
  createGoatChatDebugTrace,
  createGoatChatToolContext,
  GOAT_DEFAULT_AGENT_SYSTEM,
  normalizeAgentText,
  type StartedGoatTask,
  stringifyFinishReason,
} from "@/lib/chat-agent";
import {
  type GoatChatMessageMetadata,
  type GoatChatUiMessage,
  textFromGoatChatUiMessage,
} from "@/lib/chat-ui";
import { validateGoatChatInput } from "@/lib/chat-validation";
import { createGoatTaskForUser } from "@/lib/tasks";

export const maxDuration = 30;

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

  const store = createDbGoatChatStore();
  const turn = await createGoatChatUserTurn(
    {
      userWorkosId: context.user.workosUserId,
      prompt: parsed.value.prompt,
      model: parsed.value.model,
      sessionId: parsed.value.sessionId,
      messageId: safeClientMessageId(message.id),
    },
    store,
  );

  const toolContext = createGoatChatToolContext({
    model: turn.session.model,
    startTask: async (task) => {
      const created = await createGoatTaskForUser({
        userWorkosId: context.user.workosUserId,
        ...(task.name ? { name: task.name } : {}),
        prompt: task.prompt,
        model: task.model,
      });
      return {
        id: created.id,
        displayId: created.displayId,
        name: created.name,
        prompt: created.prompt,
      };
    },
  });

  let debugTrace: GoatChatMessageDebugTrace = createGoatChatDebugTrace({
    model: turn.session.model,
  });
  const gateway = createGateway({ apiKey: gatewayApiKey });
  const result = streamText({
    model: gateway(turn.session.model),
    system: GOAT_DEFAULT_AGENT_SYSTEM,
    messages: await convertToModelMessages(turn.messages),
    temperature: 0.2,
    maxOutputTokens: 900,
    stopWhen: stepCountIs(3),
    abortSignal: request.signal,
    tools: toolContext.tools,
    onFinish(event) {
      const finishReason = stringifyFinishReason(event.finishReason);
      debugTrace = createGoatChatDebugTrace({
        model: turn.session.model,
        steps: event.steps,
        ...(finishReason ? { finishReason } : {}),
      });
    },
    onError(event) {
      debugTrace = createGoatChatDebugTrace({
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
      if (isAborted && !rawContent && !startedTask) return;

      const finishReasonText = stringifyFinishReason(finishReason);
      const responseMessageId = safeClientMessageId(responseMessage.id);
      const finalTrace = {
        ...debugTrace,
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
    },
  });
}

function toStreamMessageMetadata(
  sessionId: string,
  task: StartedGoatTask | null,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
