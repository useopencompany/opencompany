import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: this exact path is an authorized Google OAuth
// redirect URI, so it must keep resolving on the web origin. The canonical
// API owns state verification, the code exchange, and credential persistence.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "gmail", "callback"], { basePath: "" });
}
