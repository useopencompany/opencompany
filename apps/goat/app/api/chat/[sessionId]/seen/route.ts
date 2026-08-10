import { currentGoatUser } from "@/lib/auth";
import { markGoatChatSessionSeenForUser } from "@/lib/chat";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const context = await currentGoatUser({ optional: true });
  if (!context) return Response.json({ error: "Unauthorized." }, { status: 401 });

  const { sessionId } = await params;
  const updated = await markGoatChatSessionSeenForUser({
    userWorkosId: context.user.workosUserId,
    sessionId,
  });
  if (!updated) {
    return Response.json(
      { ok: false, error: "Could not mark that chat as seen." },
      { status: 404 },
    );
  }

  return Response.json({ ok: true, error: null });
}
