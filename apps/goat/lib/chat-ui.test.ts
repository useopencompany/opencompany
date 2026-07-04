import type { GoatChatMessageDebugTrace } from "@opencompany/db/goat-schema";
import { describe, expect, it } from "vitest";
import {
  START_TASK_TOOL_PART_TYPE,
  type GoatStoredChatMessage,
  toGoatChatUiMessage,
} from "@/lib/chat-ui";
import { DEFAULT_GOAT_MODEL } from "@/lib/model-options";

describe("toGoatChatUiMessage", () => {
  it("replays persisted UI message parts in their original order", () => {
    const message = storedAssistantMessage({
      content: "Before.After",
      debugTrace: {
        schemaVersion: "opencompany.chat.debug.v1",
        model: DEFAULT_GOAT_MODEL,
        uiMessageParts: [
          { type: "text", text: "Before." },
          {
            type: START_TASK_TOOL_PART_TYPE,
            toolCallId: "tool_1",
            state: "output-available",
            input: {
              prompt: "Research the market",
              name: "Research market",
            },
            output: {
              taskId: "task_1",
              taskDisplayId: "TASK-42",
              taskName: "Research market",
              status: "queued",
              prompt: "Research the market",
            },
          },
          { type: "text", text: "After." },
        ],
      },
    });

    expect(toGoatChatUiMessage(message).parts.map((part) => part.type)).toEqual([
      "text",
      START_TASK_TOOL_PART_TYPE,
      "text",
    ]);
  });

  it("places legacy task cards before the Added to Results continuation", () => {
    const message = storedAssistantMessage({
      content:
        "This needs live Linear access, so I'm spinning up a task to pull the Goat team's current issues and give you a prioritized \"what's next\" recommendation.Added to Results as TASK-26. It'll pull the Goat team's Linear board.",
      taskId: "task_26",
      taskDisplayId: "TASK-26",
      taskName: "Linear Goat team status + next steps",
      taskPrompt: "Pull the Goat team's Linear board and recommend what to work on next.",
      debugTrace: {
        schemaVersion: "opencompany.chat.debug.v1",
        model: DEFAULT_GOAT_MODEL,
        toolResults: [
          {
            taskId: "task_26",
            taskDisplayId: "TASK-26",
            taskName: "Linear Goat team status + next steps",
            status: "queued",
            prompt: "Pull the Goat team's Linear board and recommend what to work on next.",
          },
        ],
      },
    });

    const parts = toGoatChatUiMessage(message).parts;

    expect(parts.map((part) => part.type)).toEqual(["text", START_TASK_TOOL_PART_TYPE, "text"]);
    expect(parts[0]).toEqual({
      type: "text",
      text: "This needs live Linear access, so I'm spinning up a task to pull the Goat team's current issues and give you a prioritized \"what's next\" recommendation.",
    });
    expect(parts[2]).toEqual({
      type: "text",
      text: "Added to Results as TASK-26. It'll pull the Goat team's Linear board.",
    });
  });
});

function storedAssistantMessage(
  overrides: Partial<GoatStoredChatMessage> & {
    debugTrace?: GoatChatMessageDebugTrace | null;
  } = {},
): GoatStoredChatMessage {
  const now = new Date("2026-07-04T12:00:00.000Z");
  return {
    id: "goat_chat_msg_1",
    sessionId: "goat_chat_1",
    role: "assistant",
    content: "Done.",
    taskId: null,
    debugTrace: null,
    createdAt: now,
    updatedAt: now,
    taskDisplayId: null,
    taskName: null,
    taskPrompt: null,
    ...overrides,
  };
}
