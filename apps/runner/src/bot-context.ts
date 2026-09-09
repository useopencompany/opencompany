import { botIdentityPrompt } from "@opencompany/agent/bot-prompt";
import { getDb } from "@opencompany/db";
import { chatSessions } from "@opencompany/db/product-schema";
import { and, eq } from "drizzle-orm";

export async function loadBotIdentityPrompt(conversationId: string, userWorkosId: string) {
  const [session] = await getDb()
    .select({ name: chatSessions.botName, description: chatSessions.botDescription })
    .from(chatSessions)
    .where(and(eq(chatSessions.id, conversationId), eq(chatSessions.userWorkosId, userWorkosId)))
    .limit(1);
  return botIdentityPrompt(
    session?.name ? { name: session.name, description: session.description ?? "" } : null,
  );
}
