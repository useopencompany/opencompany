import { proxyHeadlessApiRequest } from "@/lib/headless-api-proxy";

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ shareId: string; messageId: string; attachmentId: string }>;
  },
) {
  const { shareId, messageId, attachmentId } = await params;
  return proxyHeadlessApiRequest(
    request,
    ["public", "chat-shares", shareId, "attachments", messageId, attachmentId],
    { basePath: "" },
  );
}
