import type { TextStreamPart, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import {
  buildRecoverableToolStreamOutput,
  isRecoverableToolStreamError,
  normalizeReasoningSummary,
  readReasoningTextDelta,
} from "./stream-helpers";

function toolErrorPart(toolName: string, error: unknown): TextStreamPart<ToolSet> {
  return {
    type: "tool-error",
    toolName,
    toolCallId: "call_1",
    input: {},
    error,
  } as never;
}

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

describe("recoverable tool stream errors", () => {
  it("treats an unknown-tool call as recoverable so the turn does not crash", () => {
    // AI SDK NoSuchToolError message, delivered pre-stringified on the tool-error part — the exact
    // shape that crashed deferred-tool sessions when the model called a tool by its real name
    // instead of through use_tool.
    const part = toolErrorPart(
      "exa_search",
      "Model tried to call unavailable tool 'exa_search'. Available tools: read_file, use_tool.",
    );
    expect(isRecoverableToolStreamError(part)).toBe(true);
    const output = buildRecoverableToolStreamOutput(
      part as Extract<TextStreamPart<ToolSet>, { type: "tool-error" }>,
    );
    expect(output.error.code).toBe("unknown_tool");
    expect(output.error.recoverable).toBe(true);
    expect(output.error.message).toContain("find_tools");
    expect(output.error.message).toContain('use_tool({ tool: "exa_search"');
  });

  it("treats an invalid-input call as recoverable with the input-specific guidance", () => {
    const part = toolErrorPart(
      "edit_file",
      "Invalid input for tool edit_file: JSON parsing failed at position 12.",
    );
    expect(isRecoverableToolStreamError(part)).toBe(true);
    const output = buildRecoverableToolStreamOutput(
      part as Extract<TextStreamPart<ToolSet>, { type: "tool-error" }>,
    );
    expect(output.error.code).toBe("invalid_tool_input");
    expect(output.error.message).toContain("not complete valid JSON");
  });

  it("does not treat genuine tool execution failures as recoverable", () => {
    expect(
      isRecoverableToolStreamError(toolErrorPart("shell", "Tool shell crashed: segfault.")),
    ).toBe(false);
  });

  it("does not treat non-tool-error parts as recoverable", () => {
    expect(
      isRecoverableToolStreamError({ type: "error", error: new Error("gateway down") } as never),
    ).toBe(false);
  });
});
