import { isRecentChatActivity } from "@/lib/chat-activity";
import { PINNED_CHAT_LIMIT } from "@/lib/chat-ui";

export const RECENT_SIDEBAR_CHAT_LIMIT = 8;

type SidebarChatCandidate = {
  id: string;
  activityState?: "working" | "idle";
  archived?: boolean;
  archivedAt?: string | null;
  pinnedAt?: string | null;
  updatedAt: string;
};

export function selectSidebarChats<T extends SidebarChatCandidate>(
  chats: readonly T[],
  now = Date.now(),
): T[] {
  const openChats = chats.filter((chat) => !chat.archived && !chat.archivedAt);
  const pinned = openChats
    .filter((chat) => chat.pinnedAt)
    .toSorted((a, b) => new Date(b.pinnedAt ?? 0).getTime() - new Date(a.pinnedAt ?? 0).getTime())
    .slice(0, PINNED_CHAT_LIMIT);
  const working = openChats
    .filter((chat) => !chat.pinnedAt && chat.activityState === "working")
    .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const recent = openChats
    .filter(
      (chat) =>
        !chat.pinnedAt &&
        chat.activityState !== "working" &&
        isRecentChatActivity(chat.updatedAt, now),
    )
    .toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, RECENT_SIDEBAR_CHAT_LIMIT);

  return [...pinned, ...working, ...recent];
}
