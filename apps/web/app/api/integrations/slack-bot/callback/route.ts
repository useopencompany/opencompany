import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: this exact path is the Slack bot app's registered
// redirect URL. The canonical API owns state verification, the admin check,
// the code exchange, and credential persistence.
export async function GET(request: Request) {
  return proxyHeadlessApiRequest(request, ["integrations", "slack-bot", "callback"], {
    basePath: "",
  });
}
