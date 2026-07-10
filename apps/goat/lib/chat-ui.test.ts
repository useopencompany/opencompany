import type { GoatChatMessageDebugTrace } from "@opencompany/db/goat-schema";
import { describe, expect, it } from "vitest";
import {
  CODEX_COMMAND_TOOL_PART_TYPE,
  compareGoatChatMessageOrder,
  type GoatStoredChatMessage,
  nextGoatChatMessageCreatedAt,
  START_TASK_TOOL_PART_TYPE,
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

  it("replays persisted codex turns with reasoning and command parts", () => {
    const message = storedAssistantMessage({
      content: "The repo has three apps.",
      debugTrace: {
        schemaVersion: "goat.codex_chat.debug.v1",
        model: "gpt-5.5",
        uiMessageParts: [
          { type: "reasoning", text: "Scanning the repository layout." },
          {
            type: CODEX_COMMAND_TOOL_PART_TYPE,
            toolCallId: "cmd_1",
            state: "output-available",
            input: { command: "ls apps" },
            output: { status: "completed", exitCode: 0 },
          },
          { type: "text", text: "The repo has three apps." },
        ],
      },
    });

    const parts = toGoatChatUiMessage(message).parts;
    expect(parts.map((part) => part.type)).toEqual([
      "reasoning",
      CODEX_COMMAND_TOOL_PART_TYPE,
      "text",
    ]);
    expect(parts[0]).toEqual({
      type: "reasoning",
      text: "Scanning the repository layout.",
      state: "done",
    });
    // Content mirror must not be re-appended: a non-empty text part already exists.
    expect(parts.filter((part) => part.type === "text")).toHaveLength(1);
  });

  it("keeps an in-flight codex command part renderable as running", () => {
    const message = storedAssistantMessage({
      content: "",
      debugTrace: {
        schemaVersion: "goat.codex_chat.debug.v1",
        model: "gpt-5.5",
        uiMessageParts: [
          {
            type: CODEX_COMMAND_TOOL_PART_TYPE,
            toolCallId: "cmd_1",
            state: "input-available",
            input: { command: "bun test" },
          },
        ],
      },
    });

    expect(toGoatChatUiMessage(message).parts[0]).toMatchObject({
      type: CODEX_COMMAND_TOOL_PART_TYPE,
      state: "input-available",
      input: { command: "bun test" },
    });
  });

  it("preserves task id and status in message metadata", () => {
    const message = storedAssistantMessage({
      taskId: "task_1",
      taskDisplayId: "TASK-1",
      taskName: "Research market",
      taskStatus: "succeeded",
    });

    expect(toGoatChatUiMessage(message).metadata).toMatchObject({
      sessionId: "goat_chat_1",
      taskId: "task_1",
      task: {
        id: "task_1",
        displayId: "TASK-1",
        title: "Research market",
        status: "succeeded",
      },
    });
  });

  it("exposes persisted turn timing in message metadata", () => {
    const message = storedAssistantMessage({
      debugTrace: {
        schemaVersion: "goat.codex_chat.debug.v1",
        model: "gpt-5.5",
        durationMs: 153_400,
      },
      createdAt: new Date("2026-07-04T12:00:00.000Z"),
      updatedAt: new Date("2026-07-04T12:02:33.400Z"),
    });

    expect(toGoatChatUiMessage(message).metadata?.timing).toEqual({
      createdAt: "2026-07-04T12:00:00.000Z",
      updatedAt: "2026-07-04T12:02:33.400Z",
      durationMs: 153_400,
    });
  });
});

describe("compareGoatChatMessageOrder", () => {
  it("keeps equal-timestamp Codex turn placeholders in user-then-assistant order", () => {
    const createdAt = "2026-07-10T08:00:00.000Z";
    const messages = [
      { id: "assistant_1", role: "assistant" as const, createdAt },
      { id: "user_1", role: "user" as const, createdAt },
    ];

    expect(messages.toSorted(compareGoatChatMessageOrder).map((message) => message.id)).toEqual([
      "user_1",
      "assistant_1",
    ]);
  });

  it("creates a strictly later timestamp for pre-created assistant placeholders", () => {
    const userCreatedAt = new Date("2026-07-10T08:00:00.000Z");

    expect(nextGoatChatMessageCreatedAt(userCreatedAt).toISOString()).toBe(
      "2026-07-10T08:00:00.001Z",
    );
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
    taskStatus: null,
    ...overrides,
  };
}
