import { describe, expect, it } from "vitest";
import type { SessionPullRequest } from "./session-pull-requests";
import { indexByConversation } from "./use-session-pull-requests";

function link(
  conversationId: string,
  state: SessionPullRequest["state"],
  number: number,
): SessionPullRequest {
  return {
    conversationId,
    repository: "acme/web",
    number,
    url: `https://github.com/acme/web/pull/${number}`,
    state,
  };
}

describe("indexByConversation", () => {
  it("keys one PR per conversation", () => {
    const indexed = indexByConversation([link("chat-1", "open", 1), link("chat-2", "merged", 2)]);
    expect(indexed.get("chat-1")?.number).toBe(1);
    expect(indexed.get("chat-2")?.number).toBe(2);
  });

  it("shows the PR furthest through review when a session opened several", () => {
    const indexed = indexByConversation([
      link("chat-1", "draft", 1),
      link("chat-1", "merged", 2),
      link("chat-1", "open", 3),
    ]);
    expect(indexed.get("chat-1")?.number).toBe(2);
  });

  it("prefers a blocked PR over a healthy open one, because red is what needs attention", () => {
    const indexed = indexByConversation([link("chat-1", "open", 1), link("chat-1", "blocked", 2)]);
    expect(indexed.get("chat-1")?.state).toBe("blocked");
  });

  it("falls back to a closed PR only when there is nothing else", () => {
    expect(indexByConversation([link("chat-1", "closed", 1)]).get("chat-1")?.state).toBe("closed");
    expect(
      indexByConversation([link("chat-1", "closed", 1), link("chat-1", "draft", 2)]).get("chat-1")
        ?.state,
    ).toBe("draft");
  });

  it("returns an empty index for no links", () => {
    expect(indexByConversation([]).size).toBe(0);
  });
});
