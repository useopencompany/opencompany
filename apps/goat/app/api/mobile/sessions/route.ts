import { currentGoatUser } from "@/lib/auth";
import { createDbGoatChatStore } from "@/lib/chat";

export const runtime = "nodejs";

const MOBILE_SESSION_LIST_LIMIT = 30;

// Session list for native clients. The web app reads sessions through
// ElectricSQL shapes; mobile v1 polls this plain REST view instead.
export async function GET(): Promise<Response> {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response("Unauthorized", { status: 401 });

  const store = createDbGoatChatStore();
  const sessions = await store.listOpenSessions({
    userWorkosId: context.user.workosUserId,
    limit: MOBILE_SESSION_LIST_LIMIT,
  });

  return Response.json({
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title,
      model: session.model,
      engine: session.engine,
      updatedAt: session.updatedAt.toISOString(),
      pinnedAt: session.pinnedAt?.toISOString() ?? null,
    })),
  });
}
