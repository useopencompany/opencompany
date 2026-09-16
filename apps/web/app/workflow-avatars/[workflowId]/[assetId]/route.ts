import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

// Slack fetches a workflow's `icon_url` itself, with no session and from its own network. Serving
// the avatar from the web origin — rather than the API host — keeps the stored URL on the domain
// the workspace already trusts, the same way public share attachments are relayed.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ workflowId: string; assetId: string }> },
) {
  const { workflowId, assetId } = await params;
  return proxyHeadlessApiRequest(request, ["public", "workflow-avatars", workflowId, assetId], {
    basePath: "",
  });
}
