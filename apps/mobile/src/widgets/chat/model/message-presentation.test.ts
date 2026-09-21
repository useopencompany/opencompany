import { describe, expect, it } from "vitest";
import { orderedPartsFromPresentation, textFromParts } from "./message-presentation";

describe("orderedPartsFromPresentation", () => {
  it("keeps canonical text, tool, text ordering with stable identities", () => {
    const parts = orderedPartsFromPresentation({
      content: "Before.After.",
      messageId: "message_1",
      presentation: {
        uiMessageParts: [
          { type: "text", text: "Before.", itemId: "item_1" },
          {
            type: "tool-start-task",
            toolCallId: "tool_1",
            state: "output-available",
            input: { name: "Research" },
            output: { status: "queued" },
          },
          { type: "text", text: "After.", itemId: "item_2" },
        ],
      },
    });

    expect(parts.map((part) => part.type)).toEqual(["text", "tool", "text"]);
    expect(parts.map((part) => part.id)).toEqual(["text:item_1", "tool:tool_1", "text:item_2"]);
    expect(textFromParts(parts)).toBe("Before.After.");
  });

  it("keeps concurrent tools in canonical order regardless of completion state", () => {
    const parts = orderedPartsFromPresentation({
      content: "",
      messageId: "message_1",
      presentation: {
        uiMessageParts: [
          { type: "tool-search", toolCallId: "tool_1", state: "input-available" },
          { type: "tool-search", toolCallId: "tool_2", state: "output-available" },
        ],
      },
    });

    expect(parts).toMatchObject([
      { id: "tool:tool_1", status: "running" },
      { id: "tool:tool_2", status: "completed" },
    ]);
  });
});
