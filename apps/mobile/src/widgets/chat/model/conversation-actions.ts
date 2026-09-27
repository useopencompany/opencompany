import { isSettledTaskStatus } from "@opencompany/core/tasks";
import { useMutation, useMutationState } from "@tanstack/react-query";
import { router, useGlobalSearchParams } from "expo-router";
import { useAuth } from "@/features/auth";
import { analytics, captureError } from "@/shared/lib/analytics";
import { queryClient } from "@/shared/lib/query-client";
import { useToast } from "@/shared/ui/toast";
import { chatQueryKeys, useChatCoordinator } from "./chat-coordinator";
import {
  type ChatPartition,
  type SidebarFields,
  type StoredConversation,
  writeSidebarFields,
} from "./chat-store";
import { sidebarChangeGuard } from "./sidebar-change-guard";

export const PINNED_CHAT_LIMIT = 20;
const PIN_LIMIT_MESSAGE = `You can pin up to ${PINNED_CHAT_LIMIT} chats. Unpin one to pin this chat.`;
const ACTION_MUTATION_KEY = ["conversation-action"] as const;

type ConversationAction = "pin" | "unpin" | "archive";

interface ActionVariables {
  conversation: StoredConversation;
  action: ConversationAction;
}

/** What each chat menu may offer for a conversation right now, and why an item is disabled. */
export interface ConversationActionAvailability {
  canShare: boolean;
  canPin: boolean;
  canArchive: boolean;
  isPinned: boolean;
  isPending: boolean;
}

export const conversationActionAvailability = (
  conversation: StoredConversation,
  input: { online: boolean; pendingIds: ReadonlySet<string> },
): ConversationActionAvailability => {
  const isPending = input.pendingIds.has(conversation.id);
  const writable = input.online && !isPending && !conversation.provisional;
  const working =
    conversation.activityState === "working" ||
    conversation.hasLocalWork ||
    conversation.provisional;
  if (conversation.kind === "task") {
    return {
      canShare: false,
      canPin: false,
      // A Task archives only once it has settled, and never with a reply still waiting to send.
      canArchive:
        writable &&
        !conversation.hasQueuedMessages &&
        Boolean(conversation.task && isSettledTaskStatus(conversation.task.status)),
      isPinned: false,
      isPending,
    };
  }
  return {
    // Sharing publishes a saved transcript. Web holds it back while the agent is still writing.
    canShare: input.online && !conversation.provisional && !working,
    canPin: writable,
    canArchive: writable && !conversation.hasQueuedMessages,
    isPinned: Boolean(conversation.pinnedAt),
    isPending,
  };
};

const invalidateConversations = (partition: ChatPartition) =>
  queryClient.invalidateQueries({ queryKey: chatQueryKeys.conversations(partition) });

/**
 * Pin, unpin, and archive for both the sidebar and the chat's navbar menu.
 *
 * Each change lands in SQLite first so every surface moves together, then reaches the server. A
 * failure restores the previous fields. The change guard keeps a sidebar refresh that raced the
 * request from putting the old state back, and one pending change per conversation at a time
 * rules out duplicate submissions.
 */
export function useConversationActions() {
  const { api } = useAuth();
  const coordinator = useChatCoordinator();
  const { showToast, showErrorToast } = useToast();
  const { chatId: openConversationId } = useGlobalSearchParams<{ chatId?: string }>();
  const pendingIds = new Set(
    useMutationState({
      filters: { mutationKey: ACTION_MUTATION_KEY, status: "pending" },
      select: (mutation) => (mutation.state.variables as ActionVariables).conversation.id,
    }),
  );
  const online = coordinator.connectivity !== "offline";

  const mutation = useMutation({
    mutationKey: ACTION_MUTATION_KEY,
    mutationFn: async ({ conversation, action }: ActionVariables) => {
      const partition = coordinator.partition;
      if (!partition) throw new Error("Choose a workspace first.");
      const fields: Partial<SidebarFields> =
        action === "archive"
          ? { inSidebar: false }
          : { pinnedAt: action === "pin" ? new Date().toISOString() : null };
      sidebarChangeGuard.begin(conversation.id);
      try {
        const previous = await writeSidebarFields(partition, conversation.id, fields);
        await invalidateConversations(partition);
        try {
          if (conversation.kind === "task") {
            if (!conversation.task) throw new Error("This task is not available yet.");
            await api.updateTask(conversation.task.id, { archived: true }, partition.signal);
          } else if (action === "archive") {
            await api.updateConversation(conversation.id, { archived: true }, partition.signal);
          } else {
            await api.updateConversation(
              conversation.id,
              { pinned: action === "pin" },
              partition.signal,
            );
          }
        } catch (error) {
          if (previous && !partition.signal?.aborted)
            await writeSidebarFields(partition, conversation.id, previous);
          throw error;
        }
      } finally {
        sidebarChangeGuard.end(conversation.id);
        if (!partition.signal?.aborted) await invalidateConversations(partition);
      }
    },
    onSuccess: (_result, { conversation, action }) => {
      analytics.capture(
        action === "archive" ? "conversation_archived" : "conversation_pin_changed",
        action === "archive" ? { kind: conversation.kind } : { pinned: action === "pin" },
      );
      // Leaving the archived chat opens a fresh one, without raising its keyboard.
      if (action === "archive" && openConversationId === conversation.id) router.replace("/");
      void coordinator
        .refreshConversations()
        .catch((error: unknown) => captureError("conversation_list_refresh_failed", error));
    },
    onError: (error, { action }) => {
      captureError("conversation_action_failed", error, { action });
      const message =
        action === "archive"
          ? "This conversation could not be archived."
          : action === "pin"
            ? "This chat could not be pinned."
            : "This chat could not be unpinned.";
      showErrorToast(message, error, `conversation.${action}`);
    },
  });

  const run = (conversation: StoredConversation, action: ConversationAction) => {
    if (pendingIds.has(conversation.id)) return;
    if (!online) {
      showToast("Connect to the internet to change this conversation.");
      return;
    }
    if (action === "pin") {
      const pinned = queryClient
        .getQueryData<StoredConversation[]>(
          coordinator.partition ? chatQueryKeys.conversations(coordinator.partition) : [],
        )
        ?.filter((item) => item.kind === "chat" && item.inSidebar && item.pinnedAt).length;
      if ((pinned ?? 0) >= PINNED_CHAT_LIMIT) {
        showToast(PIN_LIMIT_MESSAGE);
        return;
      }
    }
    mutation.mutate({ conversation, action });
  };

  return {
    availability: (conversation: StoredConversation) =>
      conversationActionAvailability(conversation, { online, pendingIds }),
    togglePin: (conversation: StoredConversation) =>
      run(conversation, conversation.pinnedAt ? "unpin" : "pin"),
    archive: (conversation: StoredConversation) => run(conversation, "archive"),
    share: (conversation: StoredConversation) => {
      analytics.capture("conversation_share_opened");
      router.push({ pathname: "/share-sheet", params: { conversationId: conversation.id } });
    },
  };
}

/**
 * Acknowledges a conversation's unread result once the reader has it on screen. It never touches
 * awaiting-input, which only answering the pending request clears.
 */
export function useMarkConversationSeen() {
  const { api } = useAuth();
  const coordinator = useChatCoordinator();
  const mutation = useMutation({
    mutationFn: async (conversation: StoredConversation) => {
      const partition = coordinator.partition;
      if (!partition) return;
      const previous = await writeSidebarFields(partition, conversation.id, { hasUnseen: false });
      await invalidateConversations(partition);
      try {
        if (conversation.kind === "task") {
          if (conversation.task)
            await api.updateTask(conversation.task.id, { markSeen: true }, partition.signal);
        } else {
          await api.updateConversation(conversation.id, { markSeen: true }, partition.signal);
        }
      } catch (error) {
        if (previous && !partition.signal?.aborted) {
          await writeSidebarFields(partition, conversation.id, { hasUnseen: previous.hasUnseen });
          await invalidateConversations(partition);
        }
        throw error;
      }
    },
    // The unread dot simply stays; the next visit acknowledges it again.
    onError: (error) => captureError("conversation_mark_seen_failed", error),
  });
  return (conversation: StoredConversation) => {
    if (mutation.isPending || coordinator.connectivity === "offline") return;
    mutation.mutate(conversation);
  };
}
