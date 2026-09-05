import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  const { artifactId } = await params;
  return proxyHeadlessApiRequest(request, ["chat-artifacts", artifactId, "versions"]);
}
