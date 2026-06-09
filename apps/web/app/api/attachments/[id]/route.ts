import { getDb } from "@opencompany/db/client";
import { agentSessionMessageAttachments, agentSessions } from "@opencompany/db/schema";
import { get } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { currentWorkspace } from "@/lib/auth";

// Serves a message attachment's bytes from the PRIVATE Vercel Blob store. Mirrors the
// avatar route (app/api/avatar/[userId]/route.ts): auth-scoped, returns raw bytes with an
// immutable cache header. The blobUrl/blobPathname never leave the server — the client only
// ever holds the opaque attachment id and fetches through this endpoint, so a private blob
// can never be linked or shared outside the owning workspace.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  // skipOnboarding: this is a raw byte endpoint — it must never 307-redirect to /onboarding
  // (which currentWorkspace does for onboarding-incomplete users by default).
  const context = await currentWorkspace({ optional: true, skipOnboarding: true });
  if (!context) {
    return new Response(null, { status: 401 });
  }

  const { id } = await params;
  const db = getDb();
  // Join the owning session so access matches how sessions are gated everywhere else — per
  // USER, not just per workspace. Without the userId check a workspace member could fetch
  // another member's private session attachment by id.
  const [row] = await db
    .select({
      mediaType: agentSessionMessageAttachments.mediaType,
      blobUrl: agentSessionMessageAttachments.blobUrl,
      workspaceId: agentSessionMessageAttachments.workspaceId,
      sessionUserId: agentSessions.userId,
    })
    .from(agentSessionMessageAttachments)
    .innerJoin(agentSessions, eq(agentSessionMessageAttachments.sessionId, agentSessions.id))
    .where(eq(agentSessionMessageAttachments.id, id))
    .limit(1);

  // 404 (not 403) on a cross-workspace / cross-user id so the endpoint never reveals that an
  // attachment exists for someone else — same shape as "row missing".
  if (!row || row.workspaceId !== context.workspace.id || row.sessionUserId !== context.user.id) {
    return new Response(null, { status: 404 });
  }

  // The blob lives in a PRIVATE store, so the bytes require authentication. get() returns a
  // ReadableStream + metadata (token defaults to BLOB_READ_WRITE_TOKEN); useCache:false reads
  // straight from origin storage. Mirrors apps/runner/src/attachment-hydration.ts.
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
