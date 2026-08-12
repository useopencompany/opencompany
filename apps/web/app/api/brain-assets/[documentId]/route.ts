import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Temporary rollback/cached-client bridge. Authorization and private Blob access
// live exclusively in the canonical API; this route only streams its response.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  return proxyHeadlessApiRequest(request, ["brain-assets", documentId]);
}
