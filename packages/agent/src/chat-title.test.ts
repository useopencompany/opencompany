import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateChatTitle, sanitizeChatTitle } from "./chat-title";

vi.mock("ai", () => ({
  createGateway: vi.fn(() => (model: string) => ({ model })),
  generateText: vi.fn(async () => ({ text: "Generated title" })),
}));

afterEach(() => vi.clearAllMocks());

describe("generateChatTitle", () => {
  it("rejects the unrelated Armenian suffix observed on an English task", async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "Plugins page not updating after install վերադարձ",
    } as Awaited<ReturnType<typeof generateText>>);

    await expect(
      generateChatTitle({
        content:
          "After installing a plugin, navigating back still shows an Install button until I reload the page.",
        fallbackTitle: "investigate-bug",
        apiKey: "test-key",
      }),
    ).resolves.toBe("investigate-bug");
  });

  it.each([
    ["Compare café prices ☕", "Café prices ☕"],
    ["Explain naïve Bayes", "Naïve Bayes explained"],
    ["اشرح تثبيت الإضافات", "تثبيت الإضافات"],
    ["Explain the Armenian word վերադարձ", "Meaning of վերադարձ"],
    ["日本語で説明してください", "日本語の説明"],
  ])("preserves supported text for %s", async (content, title) => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: title,
    } as Awaited<ReturnType<typeof generateText>>);

    await expect(
      generateChatTitle({ content, fallbackTitle: "Fallback", apiKey: "test-key" }),
    ).resolves.toBe(title);
  });
});

describe("sanitizeChatTitle", () => {
  it("removes wrapper quotes and trailing punctuation", () => {
    expect(sanitizeChatTitle('"Compare pricing."', "Fallback")).toBe("Compare pricing");
  });

  it("falls back and caps titles at 60 characters", () => {
    expect(sanitizeChatTitle("   ", "x".repeat(80))).toBe(`${"x".repeat(57)}...`);
  });

  it("stamps Gateway attribution on title generation", async () => {
    await generateChatTitle({
      content: "What did I say about hiring?",
      fallbackTitle: "Hiring",
      apiKey: "test-key",
      userWorkosId: "user_123",
      chatSessionId: "session_123",
    });

    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { model: "openai/gpt-5.4-mini" },
        system: expect.stringContaining("Use the same language as the user message"),
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
