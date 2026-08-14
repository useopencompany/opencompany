import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: GitHub App webhook deliveries target this public web
// path. The canonical API owns signature verification over the raw body,
// delivery idempotency, buffering, and enqueueing; this route streams the
// request through unmodified so the HMAC-signed bytes are preserved.
export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "github", "events"], { basePath: "" });
}
