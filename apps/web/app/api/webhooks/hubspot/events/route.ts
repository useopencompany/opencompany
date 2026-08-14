import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the HubSpot app's webhook target URL points here, and HubSpot v3 signatures cover this exact URI. The canonical API owns signature verification over the raw body (with this web URL as a signing candidate) and event buffering; this route streams the request through unmodified.
export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "hubspot", "events"], { basePath: "" });
}
