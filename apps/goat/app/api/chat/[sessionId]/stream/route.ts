import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { currentGoatUser } from "@/lib/auth";
import { createDbGoatChatStore } from "@/lib/chat";
import {
  clearActiveGoatChatStream,
  getActiveGoatChatStream,
  getGoatChatStreamContext,
  isGoatChatResumeEnabled,
} from "@/lib/chat-streams";

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
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });
  if (!isGoatChatResumeEnabled()) return noActiveStream();

  const session = await createDbGoatChatStore().findOpenSession({
    userWorkosId: context.user.workosUserId,
    sessionId,
  });
  if (!session) return noActiveStream();

  const streamId = await getActiveGoatChatStream(session.id);
  if (!streamId) return noActiveStream();

  let stream: ReadableStream<string> | null;
  try {
    stream = await getGoatChatStreamContext().resumeExistingStream(streamId);
  } catch (error) {
    console.warn("Goat chat resumable stream could not be replayed.", {
      event: "goat.chat_resumable_stream_replay_failed",
      session_id: session.id,
      stream_id: streamId,
      error,
    });
    await clearActiveGoatChatStream(session.id, streamId);
    return noActiveStream();
  }
  if (!stream) {
    await clearActiveGoatChatStream(session.id, streamId);
    return noActiveStream();
  }

  return new Response(stream.pipeThrough(new TextEncoderStream()), {
    headers: UI_MESSAGE_STREAM_HEADERS,
  });
}

function noActiveStream() {
  return new Response(null, { status: 204 });
}
