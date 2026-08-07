import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { currentUser } from "@/lib/auth";
import { createDbChatStore } from "@/lib/chat";
import { getActiveChatStream, getChatStreamContext, isChatResumeEnabled } from "@/lib/chat-streams";

export const maxDuration = 240;
export const runtime = "nodejs";

// Reconnect endpoint for useChat({ resume: true }): replays the session's
// in-flight assistant turn from the resumable stream. 204 means "nothing to
// resume" and the client stays on its snapshot.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await params;
  const context = await currentUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });
  if (!isChatResumeEnabled()) return noActiveStream();

  const session = await createDbChatStore().findOpenSession({
    userWorkosId: context.user.workosUserId,
    sessionId,
  });
  if (!session) return noActiveStream();

  const streamId = await getActiveChatStream(session.id);
  if (!streamId) return noActiveStream();

  const stream = await getChatStreamContext()
    .resumeExistingStream(streamId)
    .catch(() => null);
  if (!stream) return noActiveStream();

  return new Response(stream.pipeThrough(new TextEncoderStream()), {
    headers: UI_MESSAGE_STREAM_HEADERS,
  });
}

function noActiveStream() {
  return new Response(null, { status: 204 });
}
