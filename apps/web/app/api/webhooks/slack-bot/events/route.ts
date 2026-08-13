import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// URL-continuity relay: the Slack bot's Events API request URL remains on the
// web origin while the canonical API verifies the raw body and dispatches the
// claimed answer to the runner.
export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "slack-bot", "events"], {
    basePath: "",
  });
}
