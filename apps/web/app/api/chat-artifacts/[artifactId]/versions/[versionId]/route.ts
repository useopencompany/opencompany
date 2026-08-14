import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ artifactId: string; versionId: string }> },
) {
  const { artifactId, versionId } = await params;
  return proxyHeadlessApiRequest(request, ["chat-artifacts", artifactId, "versions", versionId]);
}
