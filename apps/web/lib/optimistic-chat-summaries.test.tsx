import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatSummaryView } from "@/lib/chat-ui";
import {
  acceptedOptimisticChatIds,
  addOptimisticChatSummary,
  clearAllOptimisticChatSummaries,
  markOptimisticChatSummaryAccepted,
  mergeOptimisticChatSummaries,
  useOptimisticChatSummaries,
} from "@/lib/optimistic-chat-summaries";

describe("acceptedOptimisticChatIds", () => {
  it("names only the workspace's chats the API has accepted", () => {
    expect(
      acceptedOptimisticChatIds(
        [
          optimisticChat("conversation_pending", "workspace_1"),
          { ...optimisticChat("conversation_accepted", "workspace_1"), accepted: true },
          { ...optimisticChat("conversation_elsewhere", "workspace_2"), accepted: true },
        ],
        "workspace_1",
      ),
    ).toEqual(new Set(["conversation_accepted"]));
  });
});

describe("markOptimisticChatSummaryAccepted", () => {
  beforeEach(() => clearAllOptimisticChatSummaries());

  it("keeps the sidebar row while making the chat routable", () => {
    const { result } = renderHook(() => useOptimisticChatSummaries());
    act(() => {
      addOptimisticChatSummary({
        workspaceId: "workspace_1",
        sessionId: "conversation_pending",
        prompt: "Research Q3",
        model: "anthropic/claude-sonnet-5",
        engine: "opencompany",
      });
    });
    expect(acceptedOptimisticChatIds(result.current, "workspace_1")).toEqual(new Set());

    act(() => markOptimisticChatSummaryAccepted("conversation_pending"));

    expect(result.current.map((entry) => entry.chat.id)).toEqual(["conversation_pending"]);
    expect(acceptedOptimisticChatIds(result.current, "workspace_1")).toEqual(
      new Set(["conversation_pending"]),
    );
  });

  it("ignores a chat that was never optimistic here", () => {
    const { result } = renderHook(() => useOptimisticChatSummaries());
    const before = result.current;
    act(() => markOptimisticChatSummaryAccepted("conversation_unknown"));
    expect(result.current).toBe(before);
  });
});

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
