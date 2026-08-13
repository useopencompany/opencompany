import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: every per-integration Attio webhook targets this URL. The canonical API owns the per-webhook secret lookup, signature verification over the raw body, and event buffering; this route streams the request through unmodified.
export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "attio", "events"], { basePath: "" });
}
