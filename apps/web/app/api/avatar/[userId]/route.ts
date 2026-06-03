import { getDb } from "@opencompany/db/client";
import { userAvatars } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { currentWorkspace } from "@/lib/auth";

// Serves a user's custom avatar bytes from Postgres (PRO-47). Requires an authenticated
// session so the blobs aren't anonymously scrapeable. The `?v=<updatedAt>` query param
// the caller appends busts the browser cache after an upload.
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return new Response(null, { status: 401 });
  }

  const { userId } = await params;
  const db = getDb();
  const [row] = await db
    .select({ blob: userAvatars.blob, mime: userAvatars.mime })
    .from(userAvatars)
    .where(eq(userAvatars.userId, userId))
    .limit(1);

  if (!row) {
    return new Response(null, { status: 404 });
  }

  // `blob` is normalized to a Node Buffer by the bytea customType.
  const body = new Uint8Array(row.blob);
  return new Response(body, {
    headers: {
      "Content-Type": row.mime,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
