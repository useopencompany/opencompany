import { currentUser } from "@/lib/auth";
import { resolveLiveViewUrl } from "@/lib/browser-profiles";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const context = await currentUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  try {
    const { id } = await params;
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const liveViewUrl = await resolveLiveViewUrl({
      userWorkosId: context.user.workosUserId,
      profileId: id,
      sessionId,
    });
    return Response.redirect(liveViewUrl, 302);
  } catch {
    return new Response(null, { status: 404 });
  }
}
