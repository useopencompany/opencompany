import { describe, expect, it } from "vitest";
import type { ChatSummaryView } from "@/lib/chat-ui";
import { mergeOptimisticChatSummaries } from "@/lib/optimistic-chat-summaries";

describe("mergeOptimisticChatSummaries", () => {
  it("puts the pending chat ahead of persisted recents", () => {
    const merged = mergeOptimisticChatSummaries({
      persistedChats: [persistedChat("goat_chat_existing")],
      optimisticChats: [optimisticChat("goat_chat_pending", "workspace_1")],
      workspaceId: "workspace_1",
    });

    expect(merged.map((chat) => chat.id)).toEqual(["goat_chat_pending", "goat_chat_existing"]);
  });

  it("replaces the placeholder in place when the persisted row arrives", () => {
    const persisted = [persistedChat("goat_chat_1")];

    expect(
      mergeOptimisticChatSummaries({
        persistedChats: persisted,
        optimisticChats: [optimisticChat("goat_chat_1", "workspace_1")],
        workspaceId: "workspace_1",
      }),
    ).toEqual(persisted);
  });

  it("does not leak a pending chat into another workspace", () => {
    expect(
      mergeOptimisticChatSummaries({
        persistedChats: [],
        optimisticChats: [optimisticChat("goat_chat_1", "workspace_1")],
        workspaceId: "workspace_2",
      }),
    ).toEqual([]);
  });
});

function optimisticChat(id: string, workspaceId: string) {
  return {
    workspaceId,
    chat: persistedChat(id),
  };
}

function persistedChat(id: string): ChatSummaryView {
  return {
    id,
    title: "Generated Q3 title",
    model: "anthropic/claude-sonnet-5",
    engine: "opencompany",
    state: "working",
    preview: "Research Q3",
    updatedAt: new Date().toISOString(),
    lastSeenAt: null,
    pinnedAt: null,
  };
}
