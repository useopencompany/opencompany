import { generateText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { generateGoatChatTitle, sanitizeGoatChatTitle } from "./chat-title";

vi.mock("ai", () => ({
  createGateway: vi.fn(() => (model: string) => ({ model })),
  generateText: vi.fn(async () => ({ text: "Generated title" })),
}));

describe("sanitizeGoatChatTitle", () => {
  it("removes wrapper quotes and trailing punctuation", () => {
    expect(sanitizeGoatChatTitle('"Compare pricing."', "Fallback")).toBe("Compare pricing");
  });

  it("falls back and caps titles at 60 characters", () => {
    expect(sanitizeGoatChatTitle("   ", "x".repeat(80))).toBe(`${"x".repeat(57)}...`);
  });

  it("stamps Gateway attribution on title generation", async () => {
    await generateGoatChatTitle({
      content: "What did I say about hiring?",
      fallbackTitle: "Hiring",
      apiKey: "test-key",
      userWorkosId: "user_123",
      chatSessionId: "session_123",
    });

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: expect.objectContaining({
          gateway: expect.objectContaining({
            user: expect.stringMatching(/^goat-[0-9a-f]{16}$/),
            tags: expect.arrayContaining([
              "app:goat",
              "env:test",
              "feature:chat-title",
              "chat:session_123",
            ]),
          }),
        }),
      }),
    );
  });
});
