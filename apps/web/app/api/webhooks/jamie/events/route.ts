import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: every Jamie meeting webhook targets this one public path. The canonical API
// owns key lookup, connection binding, filter matching, and delivery idempotency; this route
// streams the request through unmodified.
export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "jamie", "events"], { basePath: "" });
}
