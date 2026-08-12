import { getDb } from "@opencompany/db/client";
import { goatChatMessages, goatChatSessions } from "@opencompany/db/goat-schema";
import {
  generateGoatChatTitle,
  goatChatTitleFromPrompt,
  sanitizeGoatChatTitle,
} from "@opencompany/goat-agent/chat-title";
import { and, asc, eq, isNull } from "drizzle-orm";

export { generateGoatChatTitle, sanitizeGoatChatTitle };

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
    .select({ id: goatChatSessions.id, userWorkosId: goatChatSessions.userWorkosId })
    .from(goatChatSessions)
    .where(and(eq(goatChatSessions.id, input.sessionId), isNull(goatChatSessions.closedAt)))
    .limit(1);
  if (!session) return { ok: false, skipped: "session_not_found" };

  const firstUserMessage = await loadFirstGoatUserMessage(input.sessionId);
  if (!firstUserMessage || firstUserMessage.id !== input.messageId) {
    return { ok: false, skipped: "message_not_first_user_message" };
  }

  const fallbackTitle = goatChatTitleFromPrompt(firstUserMessage.content);
  let title: string;
  try {
    title = await generateGoatChatTitle({
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
    .update(goatChatSessions)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(goatChatSessions.id, input.sessionId), isNull(goatChatSessions.closedAt)))
    .returning({ id: goatChatSessions.id });

  if (!updated) return { ok: false, skipped: "session_not_found" };
  return { ok: true, title };
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
