import { describe, expect, it } from "vitest";
import {
  addAnthropicCacheControlToLastMessage,
  buildCacheableSystemPrompt,
  normalizeReasoningSummary,
  readReasoningTextDelta,
} from "./stream-helpers";

describe("reasoning stream helpers", () => {
  it("reads reasoning parts without treating them as assistant text", () => {
    expect(readReasoningTextDelta({ type: "reasoning", text: "Reviewed constraints." })).toBe(
      "Reviewed constraints.",
    );
    expect(readReasoningTextDelta({ type: "reasoning-delta", delta: "Checked files." })).toBe(
      "Checked files.",
    );
    expect(readReasoningTextDelta({ type: "reasoning-delta", text: "AI SDK v6 chunk." })).toBe(
      "AI SDK v6 chunk.",
    );
    expect(
      readReasoningTextDelta({
        type: "raw",
        rawValue: { choices: [{ delta: { reasoning_content: "Moonshot raw chunk." } }] },
      }),
    ).toBe("Moonshot raw chunk.");
    expect(readReasoningTextDelta({ type: "text-delta", text: "Visible answer." })).toBe("");
  });

  it("normalizes empty and repeated-newline reasoning summaries", () => {
    expect(normalizeReasoningSummary("")).toBe("");
    expect(normalizeReasoningSummary("  A\n\n\n\nB  ")).toBe("A\n\nB");
  });
});

describe("prompt cache helpers", () => {
  it("marks Anthropic system prompts with a one-hour cache TTL", () => {
    expect(buildCacheableSystemPrompt("Follow the rules.", "anthropic/claude-sonnet-4.6")).toEqual({
      role: "system",
      content: "Follow the rules.",
      providerOptions: {
        anthropic: {
          cacheControl: {
            type: "ephemeral",
            ttl: "1h",
          },
        },
      },
    });
  });

  it("leaves non-Anthropic system prompts unchanged", () => {
    expect(buildCacheableSystemPrompt("Follow the rules.", "openai/gpt-5.4")).toBe(
      "Follow the rules.",
    );
  });

  it("adds one-hour Anthropic cache control to the final model message", () => {
    const messages = [
      { role: "user", content: "First question" },
      {
        role: "user",
        content: "Follow-up",
        providerOptions: {
          anthropic: {
            existing: "kept",
          },
        },
      },
    ] as const;

    expect(
      addAnthropicCacheControlToLastMessage([...messages], "anthropic/claude-sonnet-4.6"),
    ).toEqual([
      { role: "user", content: "First question" },
      {
        role: "user",
        content: "Follow-up",
        providerOptions: {
          anthropic: {
            existing: "kept",
            cacheControl: {
              type: "ephemeral",
              ttl: "1h",
            },
          },
        },
      },
    ]);
  });

  it("does not add message cache control for non-Anthropic models", () => {
    const messages = [{ role: "user", content: "Question" }] as const;

    expect(addAnthropicCacheControlToLastMessage([...messages], "openai/gpt-5.4")).toEqual([
      { role: "user", content: "Question" },
    ]);
  });
});
