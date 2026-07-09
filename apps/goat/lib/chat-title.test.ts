import { describe, expect, it } from "vitest";
import { sanitizeGoatChatTitle } from "@/lib/chat-title";

describe("sanitizeGoatChatTitle", () => {
  it("removes wrapper quotes and trailing punctuation", () => {
    expect(sanitizeGoatChatTitle('"Compare pricing."', "Fallback")).toBe("Compare pricing");
  });

  it("falls back and caps titles at 60 characters", () => {
    expect(sanitizeGoatChatTitle("   ", "x".repeat(80))).toBe(`${"x".repeat(57)}...`);
  });
});
