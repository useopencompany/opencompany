import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: this path must be registered on the HubSpot MCP auth app.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "hubspot-mcp", "callback"], {
    basePath: "",
  });
}
