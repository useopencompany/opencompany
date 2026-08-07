import { describe, expect, it } from "vitest";
import { CHAT_PROMPT_MAX_LENGTH, validateChatInput } from "@/lib/chat-validation";
import { DEFAULT_MODEL } from "@/lib/model-options";

describe("validateChatInput", () => {
  it("trims prompts and accepts supported models and session ids", () => {
    expect(
      validateChatInput({
        prompt: "  what do you think of x?  ",
        model: "openai/gpt-5.5",
        sessionId: "  goat_chat_123  ",
      }),
    ).toEqual({
      ok: true,
      value: {
        prompt: "what do you think of x?",
        model: "openai/gpt-5.5",
        sessionId: "goat_chat_123",
      },
    });
  });

  it("falls back to the default model for unsupported model ids", () => {
    expect(validateChatInput({ prompt: "hello", model: "bogus" })).toEqual({
      ok: true,
      value: { prompt: "hello", model: DEFAULT_MODEL, sessionId: null },
    });
  });

  it("rejects empty and oversized prompts", () => {
    expect(validateChatInput({ prompt: " ", model: DEFAULT_MODEL })).toMatchObject({
      ok: false,
    });
    expect(
      validateChatInput({
        prompt: "x".repeat(CHAT_PROMPT_MAX_LENGTH + 1),
        model: DEFAULT_MODEL,
      }),
    ).toMatchObject({ ok: false });
  });
});
