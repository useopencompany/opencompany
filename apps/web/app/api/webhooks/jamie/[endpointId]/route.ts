import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: each Jamie webhook targets its own connection's URL. The canonical API owns
// the connection lookup, key verification, filter matching, and delivery idempotency; this route
// streams the request through unmodified.
export async function POST(request: Request, context: { params: Promise<{ endpointId: string }> }) {
  const { endpointId } = await context.params;
  return proxyHeadlessApiRequest(request, ["webhooks", "jamie", endpointId], { basePath: "" });
}
