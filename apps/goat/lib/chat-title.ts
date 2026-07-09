import { GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS } from "@opencompany/agent-runtime";
import { getDb } from "@opencompany/db/client";
import { goatChatMessages, goatChatSessions } from "@opencompany/db/goat-schema";
import { createGateway, generateText } from "ai";
import { and, asc, eq, isNull } from "drizzle-orm";

const TITLE_MODEL = "openai/gpt-5.4-mini";
const MAX_TITLE_LENGTH = 60;
const MAX_PROMPT_CHARS = 4000;

type GoatTitleGenerationResult =
  | { ok: true; title: string }
  | {
      ok: false;
      skipped:
        | "missing_api_key"
        | "session_not_found"
        | "message_not_first_user_message"
        | "title_generation_failed";
    };

export async function generateGoatChatTitleForMessage(input: {
  sessionId: string;
  messageId: string;
  apiKey?: string | null;
}): Promise<GoatTitleGenerationResult> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) return { ok: false, skipped: "missing_api_key" };

  const db = getDb();
  const [session] = await db
    .select({ id: goatChatSessions.id })
    .from(goatChatSessions)
    .where(and(eq(goatChatSessions.id, input.sessionId), isNull(goatChatSessions.closedAt)))
    .limit(1);
  if (!session) return { ok: false, skipped: "session_not_found" };

  const firstUserMessage = await loadFirstGoatUserMessage(input.sessionId);
  if (!firstUserMessage || firstUserMessage.id !== input.messageId) {
    return { ok: false, skipped: "message_not_first_user_message" };
  }

  const fallbackTitle = titleFromPrompt(firstUserMessage.content);
  let title: string;
  try {
    title = await generateGoatChatTitle({
      content: firstUserMessage.content,
      fallbackTitle,
      apiKey,
    });
  } catch {
    return { ok: false, skipped: "title_generation_failed" };
  }

  const [updated] = await db
    .update(goatChatSessions)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(goatChatSessions.id, input.sessionId), isNull(goatChatSessions.closedAt)))
    .returning({ id: goatChatSessions.id });

  if (!updated) return { ok: false, skipped: "session_not_found" };
  return { ok: true, title };
}

export async function generateGoatChatTitle(input: {
  content: string;
  fallbackTitle: string;
  apiKey: string;
}) {
  const gateway = createGateway({ apiKey: input.apiKey });
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
    providerOptions: GATEWAY_AUTO_CACHE_PROVIDER_OPTIONS,
  });

  return sanitizeGoatChatTitle(result.text, input.fallbackTitle);
}

export function sanitizeGoatChatTitle(title: string, fallbackTitle: string) {
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

async function loadFirstGoatUserMessage(sessionId: string) {
  const [message] = await getDb()
    .select({
      id: goatChatMessages.id,
      content: goatChatMessages.content,
    })
    .from(goatChatMessages)
    .where(and(eq(goatChatMessages.sessionId, sessionId), eq(goatChatMessages.role, "user")))
    .orderBy(asc(goatChatMessages.createdAt))
    .limit(1);

  return message ?? null;
}
