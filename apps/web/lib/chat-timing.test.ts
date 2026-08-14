import { describe, expect, it } from "vitest";
import { formatChatDuration } from "@/lib/chat-timing";

describe("formatChatDuration", () => {
  it("formats sub-minute durations with tenths", () => {
    expect(formatChatDuration(3_240)).toBe("3.2s");
  });

  it("formats minute durations like the chat timer", () => {
    expect(formatChatDuration(153_400)).toBe("2m, 33.4s");
  });
});
