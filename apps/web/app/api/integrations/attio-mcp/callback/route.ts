import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: this is Attio's registered dynamic OAuth redirect.
// The canonical API owns state verification, token exchange, and persistence.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "attio-mcp", "callback"], {
    basePath: "",
  });
}
