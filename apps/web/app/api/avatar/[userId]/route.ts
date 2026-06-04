import { getDb } from "@opencompany/db/client";
import { userAvatars } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import { currentWorkspace } from "@/lib/auth";

// Serves a user's custom avatar bytes from Postgres (PRO-47). Scoped to the signed-in
// user's own avatar — the image is only shown in their own settings, so there's no
// reason to expose other users' bytes by id (avoids cross-user/cross-workspace IDOR).
// The `?v=<updatedAt>` query param the caller appends busts the browser cache after an
// upload.
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  // skipOnboarding: this is a raw image-byte endpoint — it must never 307-redirect to
  // /onboarding (which currentWorkspace does for onboarding-incomplete users by default).
  const context = await currentWorkspace({ optional: true, skipOnboarding: true });
  if (!context) {
    return new Response(null, { status: 401 });
  }

  const { userId } = await params;
  if (userId !== context.user.id) {
    return new Response(null, { status: 403 });
  }

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
      // The reader appends ?v=<updatedAt>, so each version is an immutable URL.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
