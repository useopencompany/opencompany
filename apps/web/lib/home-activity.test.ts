import { describe, expect, it } from "vitest";
import {
  HOME_ACTIVITY_WINDOW_MS,
  isRecentChatActivity,
  isRecentHomeActivity,
  RECENT_CHAT_ACTIVITY_WINDOW_MS,
} from "./home-activity";

describe("activity windows", () => {
  const now = Date.parse("2026-08-24T12:00:00.000Z");

  it("keeps chats visible through the seven-day boundary", () => {
    expect(isRecentChatActivity(new Date(now - RECENT_CHAT_ACTIVITY_WINDOW_MS), now)).toBe(true);
    expect(isRecentChatActivity(new Date(now - RECENT_CHAT_ACTIVITY_WINDOW_MS - 1), now)).toBe(
      false,
    );
  });

  it("keeps the home task activity window at one day", () => {
    expect(isRecentHomeActivity(new Date(now - HOME_ACTIVITY_WINDOW_MS), now)).toBe(true);
    expect(isRecentHomeActivity(new Date(now - HOME_ACTIVITY_WINDOW_MS - 1), now)).toBe(false);
  });
});
