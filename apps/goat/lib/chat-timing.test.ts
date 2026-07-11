import { describe, expect, it } from "vitest";
import { formatGoatChatDuration } from "@/lib/chat-timing";

describe("formatGoatChatDuration", () => {
  it("formats sub-minute durations with tenths", () => {
    expect(formatGoatChatDuration(3_240)).toBe("3.2s");
  });

  it("formats minute durations like the chat timer", () => {
    expect(formatGoatChatDuration(153_400)).toBe("2m, 33.4s");
  });
});
