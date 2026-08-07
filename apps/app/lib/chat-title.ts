import { GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { chatMessages, chatSessions } from "@opencompany/db/schema";
import { createGatewayAttribution, gatewayProviderOptions } from "@opencompany/telemetry";
import { createGateway, generateText } from "ai";
import { and, asc, eq, isNull } from "drizzle-orm";

const TITLE_MODEL = "openai/gpt-5.4-mini";
const MAX_TITLE_LENGTH = 60;
const MAX_PROMPT_CHARS = 4000;

type TitleGenerationResult =
  | { ok: true; title: string }
  | {
      ok: false;
      skipped:
        | "missing_api_key"
        | "session_not_found"
        | "message_not_first_user_message"
        | "title_generation_failed";
    };

export async function generateChatTitleForMessage(input: {
  sessionId: string;
  messageId: string;
  apiKey?: string | null;
}): Promise<TitleGenerationResult> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) return { ok: false, skipped: "missing_api_key" };

  const db = getDb();
  const [session] = await db
    .select({ id: chatSessions.id, userWorkosId: chatSessions.userWorkosId })
    .from(chatSessions)
    .where(and(eq(chatSessions.id, input.sessionId), isNull(chatSessions.closedAt)))
    .limit(1);
  if (!session) return { ok: false, skipped: "session_not_found" };

  const firstUserMessage = await loadFirstUserMessage(input.sessionId);
  if (!firstUserMessage || firstUserMessage.id !== input.messageId) {
    return { ok: false, skipped: "message_not_first_user_message" };
  }

  const fallbackTitle = titleFromPrompt(firstUserMessage.content);
  let title: string;
  try {
    title = await generateChatTitle({
      content: firstUserMessage.content,
      fallbackTitle,
      apiKey,
      userWorkosId: session.userWorkosId,
      chatSessionId: session.id,
    });
  } catch {
    return { ok: false, skipped: "title_generation_failed" };
  }

  const [updated] = await db
    .update(chatSessions)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(chatSessions.id, input.sessionId), isNull(chatSessions.closedAt)))
    .returning({ id: chatSessions.id });

  if (!updated) return { ok: false, skipped: "session_not_found" };
  return { ok: true, title };
}

export async function generateChatTitle(input: {
  content: string;
  fallbackTitle: string;
  apiKey: string;
  userWorkosId?: string | null;
  chatSessionId?: string | null;
}) {
  const gateway = createGateway({ apiKey: input.apiKey });
  const attribution = createGatewayAttribution({
    userWorkosId: input.userWorkosId,
    feature: "chat-title",
    ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
  });
  const result = await generateText({
    model: gateway(TITLE_MODEL),
    system:
      "You write compact chat titles. Return only the title, with no quotes and no punctuation at the end.",
    prompt: `Write a very short, specific title for this first user message. Keep it under ${MAX_TITLE_LENGTH} characters.\n\nMessage:\n${input.content.slice(
      0,
      MAX_PROMPT_CHARS,
    )}`,
    maxOutputTokens: 20,
    temperature: 0,
    providerOptions: gatewayProviderOptions(attribution, GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS),
  });

  return sanitizeChatTitle(result.text, input.fallbackTitle);
}

export function sanitizeChatTitle(title: string, fallbackTitle: string) {
  const normalized = title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .replace(/[.!?;:,-]+$/g, "")
    .trim();

  return truncateTitle(normalized || fallbackTitle || "New chat");
}

function titleFromPrompt(content: string) {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return truncateTitle(firstLine ?? "New chat");
}

function truncateTitle(title: string) {
  if (title.length <= MAX_TITLE_LENGTH) return title;
  return `${title.slice(0, MAX_TITLE_LENGTH - 3).trimEnd()}...`;
}

async function loadFirstUserMessage(sessionId: string) {
  const [message] = await getDb()
    .select({
      id: chatMessages.id,
      content: chatMessages.content,
    })
    .from(chatMessages)
    .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.role, "user")))
    .orderBy(asc(chatMessages.createdAt))
    .limit(1);

  return message ?? null;
}
