import { useMutation, useQuery } from "@tanstack/react-query";
import { throwIfAborted } from "@/shared/lib/abort";
import type { ChatPart } from "./chat";
import { useChatCoordinator } from "./chat-coordinator";
import { chatQueryKeys } from "./chat-queries";
import { listStoredMessages } from "./chat-store";
import { findPart } from "./message-presentation";

/**
 * One part of a message, read from the same cached transcript the chat renders. It updates live
 * while the Run streams, since the chat's observation keeps writing that transcript.
 */
export function useChatPart<T extends ChatPart["type"]>(
  type: T,
  ids: { conversationId?: string; messageId?: string; partId?: string },
) {
  const { connectivity, partition, refreshConversation } = useChatCoordinator();
  const { conversationId, messageId, partId } = ids;
  const enabled = Boolean(partition && conversationId && messageId && partId);
  const messages = useQuery({
    queryKey:
      partition && conversationId
        ? chatQueryKeys.messages(partition, conversationId)
        : ["chat", "messages", "signed-out"],
    queryFn: async ({ signal }) => {
      const stored = await listStoredMessages(partition!, conversationId!);
      throwIfAborted(signal);
      return stored;
    },
    enabled,
  });
  const message = messages.data?.find((candidate) => candidate.id === messageId);
  const found = message && partId ? findPart(message.parts, partId) : undefined;
  const part = found?.type === type ? (found as Extract<ChatPart, { type: T }>) : undefined;
  // Pulls the conversation's canonical presentations again, which is what fills in details a
  // live event left out.
  const reload = useMutation({
    mutationFn: async () => {
      if (!conversationId) return;
      const controller = new AbortController();
      await refreshConversation(conversationId, controller.signal);
    },
  });
  return {
    part,
    isLoading: enabled && messages.isLoading,
    isOffline: connectivity === "offline",
    loadError: messages.error,
    reload: () => reload.mutate(),
    isReloading: reload.isPending,
    reloadError: reload.error,
  };
}
