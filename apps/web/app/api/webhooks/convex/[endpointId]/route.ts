import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the Convex webhook log stream targets this public path. The canonical API
// owns signature verification over the raw body, delivery grouping, and event buffering; this route
// streams the request through unmodified.
export async function POST(request: Request, context: { params: Promise<{ endpointId: string }> }) {
  const { endpointId } = await context.params;
  return proxyHeadlessApiRequest(request, ["webhooks", "convex", endpointId], { basePath: "" });
}
