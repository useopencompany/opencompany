import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the GitHub App's webhook targets this public path. The canonical API owns signature verification over the raw body, delivery idempotency, and event routing; this route streams the request through unmodified.
export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "github"], { basePath: "" });
}
