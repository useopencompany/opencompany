import { describe, expect, it } from "vitest";
import { GOAT_CHAT_PROMPT_MAX_LENGTH, validateGoatChatInput } from "@/lib/chat-validation";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";

describe("validateGoatChatInput", () => {
  it("trims prompts and accepts supported models and session ids", () => {
    expect(
      validateGoatChatInput({
        prompt: "  what do you think of x?  ",
        model: "openai/gpt-5.4",
        sessionId: "  goat_chat_123  ",
      }),
    ).toEqual({
      ok: true,
      value: {
        prompt: "what do you think of x?",
        model: "openai/gpt-5.4",
        sessionId: "goat_chat_123",
      },
    });
  });

  it("falls back to the default model for unsupported model ids", () => {
    expect(validateGoatChatInput({ prompt: "hello", model: "bogus" })).toEqual({
      ok: true,
      value: { prompt: "hello", model: DEFAULT_GOAT_MODEL, sessionId: null },
    });
  });

  it("rejects empty and oversized prompts", () => {
    expect(validateGoatChatInput({ prompt: " ", model: DEFAULT_GOAT_MODEL })).toMatchObject({
      ok: false,
    });
    expect(
      validateGoatChatInput({
        prompt: "x".repeat(GOAT_CHAT_PROMPT_MAX_LENGTH + 1),
        model: DEFAULT_GOAT_MODEL,
      }),
    ).toMatchObject({ ok: false });
  });
});
