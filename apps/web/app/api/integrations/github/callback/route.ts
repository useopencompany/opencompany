import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: this exact path is registered as the GitHub App's
// callback/setup URL, so it must keep resolving on the web origin. The
// canonical API owns state verification, admin checks, the user-code
// exchange, and repository sync; this route only forwards the request.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "github", "callback"], {
    basePath: "",
  });
}
