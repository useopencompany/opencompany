import { getDb } from "@opencompany/db/client";
import { goatChatSessions } from "@opencompany/db/schema";
import { get } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { currentGoatUser } from "@/lib/auth";
import { goatChatScreenshotBlobPath, safeScreenshotFilename } from "@/lib/chat-screenshot-storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string; filename: string }> },
) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  const { sessionId, filename: rawFilename } = await params;
  let filename: string;
  try {
    filename = safeScreenshotFilename(rawFilename);
  } catch {
    return new Response(null, { status: 404 });
  }

  const [session] = await getDb()
    .select({ userWorkosId: goatChatSessions.userWorkosId })
    .from(goatChatSessions)
    .where(eq(goatChatSessions.id, sessionId))
    .limit(1);
  if (!session || session.userWorkosId !== context.user.workosUserId) {
    return new Response(null, { status: 404 });
  }

  const result = await get(
    goatChatScreenshotBlobPath({
      userWorkosId: context.user.workosUserId,
      chatSessionId: sessionId,
      filename,
    }),
    { access: "private", useCache: false },
  );
  if (!result || result.statusCode !== 200 || !result.stream) {
    return new Response(null, { status: 404 });
  }

  return new Response(result.stream, {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}
