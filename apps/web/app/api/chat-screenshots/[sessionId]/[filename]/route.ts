import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string; filename: string }> },
) {
  const { sessionId, filename } = await params;
  return proxyHeadlessApiRequest(request, ["chat-screenshots", sessionId, filename]);
}
