import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ shareId: string; artifactId: string; versionId: string }>;
  },
) {
  const { shareId, artifactId, versionId } = await params;
  return proxyHeadlessApiRequest(
    request,
    ["public", "chat-shares", shareId, "artifacts", artifactId, "versions", versionId],
    { basePath: "" },
  );
}
