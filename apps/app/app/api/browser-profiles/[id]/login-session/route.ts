import { currentUser } from "@/lib/auth";
import { createLoginSession } from "@/lib/browser-profiles";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await currentUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  try {
    const { id } = await params;
    const session = await createLoginSession({
      userWorkosId: context.user.workosUserId,
      profileId: id,
    });
    return Response.json(session);
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Could not create login session.",
      },
      { status: 400 },
    );
  }
}
