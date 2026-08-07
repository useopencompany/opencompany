import { currentUser } from "@/lib/auth";
import { deleteBrowserProfile } from "@/lib/browser-profiles";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await currentUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  try {
    const { id } = await params;
    await deleteBrowserProfile({
      userWorkosId: context.user.workosUserId,
      profileId: id,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Could not delete browser profile.",
      },
      { status: 400 },
    );
  }
}
