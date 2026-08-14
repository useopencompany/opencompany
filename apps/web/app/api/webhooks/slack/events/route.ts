import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the Slack app's Events API request URL points here. The canonical API owns signature verification over the raw body, the url_verification handshake, and message buffering; this route streams the request through unmodified.
export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "slack", "events"], { basePath: "" });
}
