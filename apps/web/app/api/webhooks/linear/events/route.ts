import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the Linear webhook targets this public path. The canonical API owns signature verification over the raw body, delivery idempotency, and event buffering; this route streams the request through unmodified.
export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "linear", "events"], { basePath: "" });
}
