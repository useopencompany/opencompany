import { createCloudChatMessageHandler } from "@/lib/cloud-chat-message-handler";

export const runtime = "nodejs";

export const POST = createCloudChatMessageHandler({
  engine: "claude_code",
  invalidMessage: "Invalid Claude chat message.",
});
