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

  const streamContext = getGoatChatStreamContext();
  let stream: ReadableStream<string> | null | undefined;
  try {
    stream = await streamContext.resumeExistingStream(streamId);
  } catch (error) {
    try {
      // One retry keeps a transient durable-stream read failure from making a
      // healthy producer unreachable. A second failure means this pointer can
      // no longer help the client reconnect.
      stream = await streamContext.resumeExistingStream(streamId);
    } catch (retryError) {
      console.warn("Goat chat resumable stream could not be replayed.", {
        event: "goat.chat_resumable_stream_replay_failed",
        session_id: session.id,
        stream_id: streamId,
        error,
        retry_error: retryError,
      });
      await clearActiveGoatChatStream(session.id, streamId);
      return noActiveStream();
    }
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
