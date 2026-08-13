import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the GitHub App install flow starts from this public
// web path. The canonical API owns the session check, signed state, and the
// redirect to GitHub; this route only forwards the request unchanged.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "github", "start"], { basePath: "" });
}
