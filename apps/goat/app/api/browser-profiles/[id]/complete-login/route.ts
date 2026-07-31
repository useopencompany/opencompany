import { currentGoatUser } from "@/lib/auth";
import { completeLoginSession } from "@/lib/browser-profiles";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await currentGoatUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  try {
    const { id } = await params;
    const body = (await request.json()) as { sessionId?: unknown };
    await completeLoginSession({
      userWorkosId: context.user.workosUserId,
      profileId: id,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : "",
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Could not complete login.",
      },
      { status: 400 },
    );
  }
}
