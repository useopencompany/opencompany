import "server-only";

export {
  generateGoatChatTitle,
  sanitizeGoatChatTitle,
} from "@opencompany/goat-agent/chat-title";

import { serverApiClient } from "@/lib/server-api-client";

type GoatTitleGenerationResult =
  | { ok: true; title: string }
  | {
      ok: false;
      skipped:
        | "missing_api_key"
        | "session_not_found"
        | "message_not_first_user_message"
        | "title_generation_failed";
    };

// Retained only for the routes awaiting the deletion PR. The mutation itself is
// API-owned; canonical /v1 Message creation triggers the same service directly.
export async function generateGoatChatTitleForMessage(input: {
  sessionId: string;
  messageId: string;
  apiKey?: string | null;
}): Promise<GoatTitleGenerationResult> {
  if (!input.apiKey?.trim()) return { ok: false, skipped: "missing_api_key" };
  try {
    const client = await serverApiClient();
    const response = await client.v1.conversations[":conversationId"].title.$post({
      param: { conversationId: input.sessionId },
      json: { messageId: input.messageId },
    });
    if (!response.ok) {
      return {
        ok: false,
        skipped: response.status === 404 ? "session_not_found" : "title_generation_failed",
      };
    }
    const result = (await response.json()).data;
    return result.generated && result.title
      ? { ok: true, title: result.title }
      : { ok: false, skipped: "message_not_first_user_message" };
  } catch {
    return { ok: false, skipped: "title_generation_failed" };
  }
}
