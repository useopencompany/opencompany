import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: this exact path is the X OAuth application's
// registered redirect URL. The canonical API owns state verification, the
// PKCE code exchange, and credential persistence.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "x-account", "callback"], {
    basePath: "",
  });
}
