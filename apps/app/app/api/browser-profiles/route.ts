import { currentUser } from "@/lib/auth";
import { createBrowserProfile, listBrowserProfilesForUser } from "@/lib/browser-profiles";

export async function GET() {
  const context = await currentUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  const profiles = await listBrowserProfilesForUser(context.user.workosUserId);
  return Response.json({ profiles });
}

export async function POST(request: Request) {
  const context = await currentUser({ optional: true });
  if (!context) return new Response(null, { status: 401 });

  try {
    const body = (await request.json()) as { name?: unknown; url?: unknown };
    const profile = await createBrowserProfile({
      userWorkosId: context.user.workosUserId,
      name: typeof body.name === "string" ? body.name : "",
      siteUrl: typeof body.url === "string" ? body.url : "",
    });
    return Response.json({ profile }, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Could not create browser profile.",
      },
      { status: 400 },
    );
  }
}
