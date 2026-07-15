import { currentGoatUser } from "@/lib/auth";
import { loadGoatChatSessionByIdForUser } from "@/lib/chat";

export const runtime = "nodejs";

// Full message history for one session, as GoatChatUiMessage[] — the same
// shape the chat stream produces, so the mobile client renders one format.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });

  const { sessionId } = await params;
  const chat = await loadGoatChatSessionByIdForUser({
    userWorkosId: context.user.workosUserId,
    sessionId,
  });
  if (!chat) return new Response("Not found", { status: 404 });

  return Response.json({ chat });
}
