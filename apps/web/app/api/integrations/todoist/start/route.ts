import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the canonical API owns the Todoist MCP OAuth flow.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "todoist", "start"], {
    basePath: "",
  });
}
