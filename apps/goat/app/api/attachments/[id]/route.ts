import { getDb } from "@opencompany/db/client";
import { goatMessageAttachments } from "@opencompany/db/goat-schema";
import { get } from "@vercel/blob";
import { and, eq } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  const { id } = await params;
  const [row] = await getDb()
    .select({
      mediaType: goatMessageAttachments.mediaType,
      blobUrl: goatMessageAttachments.blobUrl,
    })
    .from(goatMessageAttachments)
    .where(
      and(
        eq(goatMessageAttachments.id, id),
        eq(goatMessageAttachments.userWorkosId, context.user.workosUserId),
      ),
    )
    .limit(1);

  if (!row) return new Response(null, { status: 404 });

  const result = await get(row.blobUrl, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) {
    return new Response(null, { status: 404 });
  }

  const body = await readStreamToBuffer(result.stream);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": row.mediaType,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
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
