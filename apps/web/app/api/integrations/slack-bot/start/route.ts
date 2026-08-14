import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the canonical API owns the Slack answer-bot OAuth
// flow and Events API ingress.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "slack-bot", "start"], {
    basePath: "",
  });
}
