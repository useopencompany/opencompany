import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: this exact path is the Linear OAuth application's registered redirect URL. The canonical API owns state verification, the code exchange, and credential persistence.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "linear-ingest", "callback"], {
    basePath: "",
  });
}
