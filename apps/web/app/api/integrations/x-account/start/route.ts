import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the canonical API owns the X account OAuth flow,
// including minting the PKCE verifier cookie that this relay streams back.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "x-account", "start"], {
    basePath: "",
  });
}
