import { legacyBrowserProfileLiveView } from "@/lib/browser-profile-route-adapter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Live-view links embedded in existing Chat transcripts resolve through this
// web-origin path; it must keep working after the API cutover. The canonical
// API authorizes the session and resolves the target; this route only issues
// the redirect.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return legacyBrowserProfileLiveView(request, id);
}
