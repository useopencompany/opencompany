import { getDb } from "@opencompany/db/client";
import { goatChatMessages, goatChatShares } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { goatChatAttachmentResponse } from "@/lib/chat-attachment-response";
import { isGoatChatShareId } from "@/lib/chat-sharing";

export async function GET(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ shareId: string; messageId: string; attachmentId: string }>;
  },
) {
  const { shareId, messageId, attachmentId } = await params;
  if (!isGoatChatShareId(shareId)) return new Response(null, { status: 404 });

  const db = getDb();
  const [row] = await db
    .select({ attachments: goatChatMessages.attachments })
    .from(goatChatMessages)
    .innerJoin(goatChatShares, eq(goatChatMessages.sessionId, goatChatShares.chatSessionId))
    .where(and(eq(goatChatShares.id, shareId), eq(goatChatMessages.id, messageId)))
    .limit(1);

  const attachment = (row?.attachments ?? []).find((entry) => entry.id === attachmentId);
  if (!attachment) return new Response(null, { status: 404 });

  return goatChatAttachmentResponse(attachment);
}
