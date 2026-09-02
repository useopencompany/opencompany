import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// This web-origin URL is registered as the dedicated GitHub App's user
// authorization callback; the canonical API verifies and exchanges the code.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "github-user", "callback"], {
    basePath: "",
  });
}
