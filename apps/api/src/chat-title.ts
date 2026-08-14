import { chatTitleFromPrompt, generateChatTitle } from "@opencompany/agent/chat-title";
import type { Actor } from "@opencompany/core";
import { chatMessages, chatSessions } from "@opencompany/db/product-schema";
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
        .select({ id: chatSessions.id, userWorkosId: chatSessions.userWorkosId })
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.id, conversationId),
            eq(chatSessions.userWorkosId, actor.userId),
            eq(chatSessions.kind, "chat"),
            isNull(chatSessions.closedAt),
          ),
        )
        .limit(1);
      if (!session) return { conversationId, title: null, generated: false };

      const [firstMessage] = await input.db
        .select({ id: chatMessages.id, content: chatMessages.content })
        .from(chatMessages)
        .where(and(eq(chatMessages.sessionId, conversationId), eq(chatMessages.role, "user")))
        .orderBy(asc(chatMessages.createdAt))
        .limit(1);
      if (!firstMessage || firstMessage.id !== messageId) {
        return { conversationId, title: null, generated: false };
      }

      const title = await generateChatTitle({
        content: firstMessage.content,
        fallbackTitle: chatTitleFromPrompt(firstMessage.content),
        apiKey,
        userWorkosId: actor.userId,
        chatSessionId: conversationId,
      });
      const [updated] = await input.db
        .update(chatSessions)
        .set({ title, updatedAt: new Date() })
        .where(
          and(
            eq(chatSessions.id, conversationId),
            eq(chatSessions.userWorkosId, actor.userId),
            isNull(chatSessions.closedAt),
          ),
        )
        .returning({ id: chatSessions.id });
      return { conversationId, title: updated ? title : null, generated: Boolean(updated) };
    },
  };
}
