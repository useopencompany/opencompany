import { getDb } from "@opencompany/db/client";
import { goatChatMessages, goatChatSessions } from "@opencompany/db/goat-schema";
import { get } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";

// Serves a chat attachment's bytes from the PRIVATE Vercel Blob store.
// Mirrors /api/brain-assets/[documentId]: auth-scoped raw byte endpoint; the
// blob URL never leaves the server — the client only holds message id +
// attachment id and fetches through here.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string; attachmentId: string }> },
) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  const { messageId, attachmentId } = await params;
  const db = getDb();
  const [row] = await db
    .select({
      attachments: goatChatMessages.attachments,
      ownerWorkosId: goatChatSessions.userWorkosId,
    })
    .from(goatChatMessages)
    .innerJoin(goatChatSessions, eq(goatChatMessages.sessionId, goatChatSessions.id))
    .where(eq(goatChatMessages.id, messageId))
    .limit(1);

  // 404 (not 403) on cross-user ids so the endpoint never reveals that a
  // message exists for someone else — same shape as "row missing".
  const attachment =
    row && row.ownerWorkosId === context.user.workosUserId
      ? (row.attachments ?? []).find((entry) => entry.id === attachmentId)
      : undefined;
  if (!attachment) return new Response(null, { status: 404 });

  const result = await get(attachment.blobUrl, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) {
    return new Response(null, { status: 404 });
  }

  const body = await readStreamToBuffer(result.stream);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": attachment.mediaType || "application/octet-stream",
      "Content-Length": String(body.byteLength),
      "Content-Disposition": `inline; filename="${sanitizeFileName(attachment.filename)}"`,
      // Attachments are immutable after send.
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function sanitizeFileName(value: string | null): string {
  const name = (value ?? "file").replace(/[\r\n"\\]/g, "_").trim();
  return name || "file";
}

async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}
