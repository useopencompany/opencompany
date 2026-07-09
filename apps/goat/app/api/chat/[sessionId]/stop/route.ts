import { currentGoatUser } from "@/lib/auth";
import { createDbGoatChatStore } from "@/lib/chat";
import { isGoatChatResumeEnabled, requestGoatChatStop } from "@/lib/chat-streams";

// Explicit stop for a resumable chat turn. With resume enabled, closing the
// HTTP connection is just a disconnect, so the stop button additionally posts
// here; the chat route's stop watcher aborts generation, which persists the
// partial response through the regular stream onFinish path.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await params;
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });
  if (!isGoatChatResumeEnabled()) return Response.json({ ok: true, stopped: false });

  const session = await createDbGoatChatStore().findOpenSession({
    userWorkosId: context.user.workosUserId,
    sessionId,
  });
  if (!session) return Response.json({ ok: true, stopped: false });

  const stopped = await requestGoatChatStop(session.id);
  return Response.json({ ok: true, stopped });
}
