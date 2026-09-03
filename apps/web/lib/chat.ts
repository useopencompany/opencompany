import "server-only";

import type { ConversationDto } from "@opencompany/protocol";
import type { ChatSessionView, ChatSummaryView } from "@/lib/chat-ui";
import { normalizeConversationModel } from "@/lib/model-options";
import { serverApiClient, serverApiError } from "@/lib/server-api-client";

const RECENT_CHAT_LIMIT = "100";

export type { ChatSessionView, ChatSummaryView } from "@/lib/chat-ui";

export async function loadCurrentChatSessionById(
  sessionId: string | null | undefined,
): Promise<ChatSessionView | null> {
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

export async function listCurrentUserRecentChats(): Promise<ChatSummaryView[]> {
  const client = await serverApiClient();
  const response = await client.v1.conversations.$get({
    query: { limit: RECENT_CHAT_LIMIT },
  });
  if (!response.ok) throw await serverApiError(response, "Could not load recent chats.");

  return (await response.json()).data.map(toChatSummaryView);
}

function toChatSessionView(conversation: ConversationDto): ChatSessionView {
  return {
    id: conversation.id,
    title: conversation.title,
    model: normalizeConversationModel(conversation.engine, conversation.model),
    engine: conversation.engine,
    codexComposerSettings: null,
    runtime: conversation.runtime,
    activityState: conversation.activityState,
    hasUnseen: conversation.hasUnseen,
    updatedAt: conversation.updatedAt,
    // The API-owned Electric read model hydrates the transcript in Surface.
    messages: [],
  };
}

function toChatSummaryView(conversation: ConversationDto): ChatSummaryView {
  return {
    id: conversation.id,
    title: conversation.title,
    model: normalizeConversationModel(conversation.engine, conversation.model),
    engine: conversation.engine,
    codexComposerSettings: null,
    runtime: conversation.runtime,
    activityState: conversation.activityState,
    hasUnseen: conversation.hasUnseen,
    preview: "No messages yet.",
    updatedAt: conversation.updatedAt,
    lastSeenAt: null,
    pinnedAt: conversation.pinnedAt ?? null,
  };
}
