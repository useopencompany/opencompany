import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the canonical API owns the personal GitHub App
// install/authorize flow and encrypted credential persistence.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "github-user", "start"], {
    basePath: "",
  });
}
