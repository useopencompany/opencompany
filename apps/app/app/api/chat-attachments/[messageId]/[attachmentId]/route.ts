import { getDb } from "@opencompany/db/client";
import { chatMessages, chatSessions } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { currentUser } from "@/lib/auth";
import { chatAttachmentResponse } from "@/lib/chat-attachment-response";

// Serves a chat attachment's bytes from the PRIVATE Vercel Blob store.
// Mirrors /api/brain-assets/[documentId]: auth-scoped raw byte endpoint; the
// blob URL never leaves the server — the client only holds message id +
// attachment id and fetches through here.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string; attachmentId: string }> },
) {
  const context = await currentUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  const { messageId, attachmentId } = await params;
  const db = getDb();
  const [row] = await db
    .select({
      attachments: chatMessages.attachments,
      ownerWorkosId: chatSessions.userWorkosId,
    })
    .from(chatMessages)
    .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
    .where(eq(chatMessages.id, messageId))
    .limit(1);

  // 404 (not 403) on cross-user ids so the endpoint never reveals that a
  // message exists for someone else — same shape as "row missing".
  const attachment =
    row && row.ownerWorkosId === context.user.workosUserId
      ? (row.attachments ?? []).find((entry) => entry.id === attachmentId)
      : undefined;
  if (!attachment) return new Response(null, { status: 404 });

  return chatAttachmentResponse(attachment);
}
