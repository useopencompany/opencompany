import { getDb } from "@opencompany/db/client";
import { chatMessages, chatShares } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { chatAttachmentResponse } from "@/lib/chat-attachment-response";
import { isChatShareId } from "@/lib/chat-sharing";

export async function GET(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ shareId: string; messageId: string; attachmentId: string }>;
  },
) {
  const { shareId, messageId, attachmentId } = await params;
  if (!isChatShareId(shareId)) return new Response(null, { status: 404 });

  const db = getDb();
  const [row] = await db
    .select({ attachments: chatMessages.attachments })
    .from(chatMessages)
    .innerJoin(chatShares, eq(chatMessages.sessionId, chatShares.chatSessionId))
    .where(and(eq(chatShares.id, shareId), eq(chatMessages.id, messageId)))
    .limit(1);

  const attachment = (row?.attachments ?? []).find((entry) => entry.id === attachmentId);
  if (!attachment) return new Response(null, { status: 404 });

  return chatAttachmentResponse(attachment);
}
