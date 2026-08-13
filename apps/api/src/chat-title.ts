import type { Actor } from "@opencompany/core";
import { goatChatMessages, goatChatSessions } from "@opencompany/db/goat-schema";
import { generateGoatChatTitle, goatChatTitleFromPrompt } from "@opencompany/goat-agent/chat-title";
import { and, asc, eq, isNull } from "drizzle-orm";

export type ChatTitleGenerationResult = {
  conversationId: string;
  title: string | null;
  generated: boolean;
};

export type ChatTitleService = {
  generate(
    actor: Actor,
    conversationId: string,
    messageId: string,
  ): Promise<ChatTitleGenerationResult>;
};

export function createChatTitleService(input: {
  db: any;
  apiKey?: string | null;
}): ChatTitleService {
  return {
    async generate(actor, conversationId, messageId) {
      const apiKey = input.apiKey?.trim();
      if (!apiKey) return { conversationId, title: null, generated: false };

      const [session] = await input.db
        .select({ id: goatChatSessions.id, userWorkosId: goatChatSessions.userWorkosId })
        .from(goatChatSessions)
        .where(
          and(
            eq(goatChatSessions.id, conversationId),
            eq(goatChatSessions.userWorkosId, actor.userId),
            eq(goatChatSessions.kind, "chat"),
            isNull(goatChatSessions.closedAt),
          ),
        )
        .limit(1);
      if (!session) return { conversationId, title: null, generated: false };

      const [firstMessage] = await input.db
        .select({ id: goatChatMessages.id, content: goatChatMessages.content })
        .from(goatChatMessages)
        .where(
          and(eq(goatChatMessages.sessionId, conversationId), eq(goatChatMessages.role, "user")),
        )
        .orderBy(asc(goatChatMessages.createdAt))
        .limit(1);
      if (!firstMessage || firstMessage.id !== messageId) {
        return { conversationId, title: null, generated: false };
      }

      const title = await generateGoatChatTitle({
        content: firstMessage.content,
        fallbackTitle: goatChatTitleFromPrompt(firstMessage.content),
        apiKey,
        userWorkosId: actor.userId,
        chatSessionId: conversationId,
      });
      const [updated] = await input.db
        .update(goatChatSessions)
        .set({ title, updatedAt: new Date() })
        .where(
          and(
            eq(goatChatSessions.id, conversationId),
            eq(goatChatSessions.userWorkosId, actor.userId),
            isNull(goatChatSessions.closedAt),
          ),
        )
        .returning({ id: goatChatSessions.id });
      return { conversationId, title: updated ? title : null, generated: Boolean(updated) };
    },
  };
}
