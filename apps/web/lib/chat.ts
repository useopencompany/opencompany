import "server-only";

import type { ConversationDto } from "@opencompany/protocol";
import type { GoatChatSessionView, GoatChatSummaryView } from "@/lib/chat-ui";
import { normalizeGoatModel } from "@/lib/model-options";
import { serverApiClient, serverApiError } from "@/lib/server-api-client";

const GOAT_RECENT_CHAT_LIMIT = "100";

export type { GoatChatSessionView, GoatChatSummaryView } from "@/lib/chat-ui";

export async function loadCurrentGoatChatSessionById(
  sessionId: string | null | undefined,
): Promise<GoatChatSessionView | null> {
  const trimmed = sessionId?.trim();
  if (!trimmed) return null;

  const client = await serverApiClient();
  const response = await client.v1.conversations[":conversationId"].$get({
    param: { conversationId: trimmed },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await serverApiError(response, "Could not load that chat.");

  return toChatSessionView((await response.json()).data);
}

export async function listCurrentUserRecentGoatChats(): Promise<GoatChatSummaryView[]> {
  const client = await serverApiClient();
  const response = await client.v1.conversations.$get({
    query: { limit: GOAT_RECENT_CHAT_LIMIT },
  });
  if (!response.ok) throw await serverApiError(response, "Could not load recent chats.");

  return (await response.json()).data.map(toChatSummaryView);
}

function toChatSessionView(conversation: ConversationDto): GoatChatSessionView {
  return {
    id: conversation.id,
    title: conversation.title,
    model: normalizeGoatModel(conversation.model),
    engine: conversation.engine,
    codexComposerSettings: null,
    codexRuntime: null,
    // The API-owned Electric read model hydrates the transcript in GoatSurface.
    messages: [],
  };
}

function toChatSummaryView(conversation: ConversationDto): GoatChatSummaryView {
  return {
    id: conversation.id,
    title: conversation.title,
    model: normalizeGoatModel(conversation.model),
    engine: conversation.engine,
    codexComposerSettings: null,
    codexRuntime: null,
    state: "done_seen",
    preview: "No messages yet.",
    updatedAt: conversation.updatedAt,
    lastSeenAt: conversation.updatedAt,
    pinnedAt: null,
  };
}
