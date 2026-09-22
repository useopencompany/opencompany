import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Keep the GitHub App's public webhook URL on the web origin. The canonical API verifies the
// signature over the unchanged body and routes the delivery to the connected personal account.
export async function POST(request: Request) {
  return proxyHeadlessApiRequest(request, ["webhooks", "github-user", "events"], {
    basePath: "",
  });
}
