import type { ChatMessageAttachment } from "@opencompany/db/schema";
import { get } from "@vercel/blob";

export async function chatAttachmentResponse(attachment: ChatMessageAttachment): Promise<Response> {
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
      // Attachments are immutable after send. Keep this private even for public
      // share URLs so bearer tokens never seed shared intermediary caches.
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
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
