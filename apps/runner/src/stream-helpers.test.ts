import { describe, expect, it } from "vitest";
import { normalizeReasoningSummary, readReasoningTextDelta } from "./stream-helpers";

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
