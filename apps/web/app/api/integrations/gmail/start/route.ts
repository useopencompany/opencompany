import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the canonical API owns the Google OAuth flow; this
// public web path only forwards the request unchanged.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "gmail", "start"], { basePath: "" });
}
