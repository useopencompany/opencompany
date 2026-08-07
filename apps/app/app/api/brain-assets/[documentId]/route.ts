import { getDb } from "@opencompany/db/client";
import { goatBrainDocuments } from "@opencompany/db/schema";
import { get } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";

// Serves a brain asset's bytes (PDF today) from the PRIVATE Vercel Blob
// store. Mirrors apps/web/app/api/attachments/[id]/route.ts: auth-scoped raw
// byte endpoint; the blob URL never leaves the server — clients only hold the
// opaque document id and fetch through here, so a private blob can never be
// linked outside the brain's membership.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  const { documentId } = await params;
  const db = getDb();
  const [row] = await db
    .select({
      brainRef: goatBrainDocuments.brainRef,
      mimeType: goatBrainDocuments.mimeType,
      originalFileName: goatBrainDocuments.originalFileName,
      assetStorageKey: goatBrainDocuments.assetStorageKey,
    })
    .from(goatBrainDocuments)
    .where(eq(goatBrainDocuments.id, documentId))
    .limit(1);

  // 404 (not 403) on cross-brain ids so the endpoint never reveals that a
  // document exists for someone else — same shape as "row missing".
  const accessible = row && context.brains.some((brain) => brain.id === row.brainRef);
  if (!accessible || !row.assetStorageKey) {
    return new Response(null, { status: 404 });
  }

  const result = await get(row.assetStorageKey, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) {
    return new Response(null, { status: 404 });
  }

  const body = await readStreamToBuffer(result.stream);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": row.mimeType ?? "application/octet-stream",
      "Content-Length": String(body.byteLength),
      // Inline so browsers render PDFs in place; the filename covers "save as".
      "Content-Disposition": `inline; filename="${sanitizeFileName(row.originalFileName)}"`,
      // Re-uploads swap the blob behind the same document id, so bytes are
      // cacheable per user but not immutable.
      "Cache-Control": "private, max-age=3600",
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
