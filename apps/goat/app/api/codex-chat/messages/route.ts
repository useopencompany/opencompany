import { createCloudChatMessageHandler } from "@/lib/cloud-chat-message-handler";

export const runtime = "nodejs";

export const POST = createCloudChatMessageHandler({
  engine: "codex",
  invalidMessage: "Invalid Codex chat message.",
});
