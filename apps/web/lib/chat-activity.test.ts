import { describe, expect, it } from "vitest";
import { isRecentChatActivity, RECENT_CHAT_ACTIVITY_WINDOW_MS } from "./chat-activity";

describe("chat activity window", () => {
  const now = Date.parse("2026-08-24T12:00:00.000Z");

  it("keeps chats visible through the seven-day boundary", () => {
    expect(isRecentChatActivity(new Date(now - RECENT_CHAT_ACTIVITY_WINDOW_MS), now)).toBe(true);
    expect(isRecentChatActivity(new Date(now - RECENT_CHAT_ACTIVITY_WINDOW_MS - 1), now)).toBe(
      false,
    );
  });
});
