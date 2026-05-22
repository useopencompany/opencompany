import { describe, expect, it } from "vitest";
import {
  applyRuntimeEventToState,
  buildAssistantTurnParts,
  buildRuntimeToolCallsForMessage,
  isInspectableRuntimeEvent,
  type RuntimeEvent,
  type SessionRuntimeState,
} from "./runtime-events";

function initialState(): SessionRuntimeState {
  return {
    events: [],
    messages: [{ id: "msg_user", role: "user", content: "Hi", status: "completed" }],
    currentStatus: "running",
    lastError: null,
  };
}

describe("applyRuntimeEventToState", () => {
  it("applies assistant message lifecycle events", () => {
    let state = initialState();

    state = applyRuntimeEventToState(
      state,
      event(1, "message.created", {
        messageId: "msg_assistant",
        role: "assistant",
      }),
    );
    state = applyRuntimeEventToState(
      state,
      event(2, "message.completed", {
        messageId: "msg_assistant",
        content: "Hello there",
      }),
    );

    expect(state.messages).toContainEqual({
      id: "msg_assistant",
      role: "assistant",
      content: "Hello there",
      status: "completed",
    });
  });

  it("can still apply legacy message delta events", () => {
    let state = initialState();
    state = applyRuntimeEventToState(
      state,
      event(1, "message.created", {
        messageId: "msg_assistant",
        role: "assistant",
      }),
    );
    state = applyRuntimeEventToState(
      state,
      event(2, "message.delta", {
        messageId: "msg_assistant",
        delta: "Hello",
      }),
    );
    state = applyRuntimeEventToState(
      state,
      event(3, "message.delta", {
        messageId: "msg_assistant",
        delta: " there",
      }),
    );

    expect(state.messages.find((message) => message.id === "msg_assistant")?.content).toBe(
      "Hello there",
    );
  });

  it("does not apply duplicate event ids twice", () => {
    let state = initialState();
    state = applyRuntimeEventToState(
      state,
      event(1, "message.created", {
        messageId: "msg_assistant",
        role: "assistant",
      }),
    );

    const delta = event(2, "message.delta", {
      messageId: "msg_assistant",
      delta: "A",
    });
    state = applyRuntimeEventToState(state, delta);
    state = applyRuntimeEventToState(state, delta);

    expect(state.messages.find((message) => message.id === "msg_assistant")?.content).toBe("A");
    expect(state.events.map((item) => item.id)).toEqual([1, 2]);
  });

  it("updates session status and error state", () => {
    let state = initialState();
    state = applyRuntimeEventToState(state, event(1, "session.error", { message: "Gateway down" }));
    expect(state.currentStatus).toBe("failed");
    expect(state.lastError).toBe("Gateway down");

    state = applyRuntimeEventToState(state, event(2, "session.status", { status: "running" }));
    expect(state.currentStatus).toBe("running");
    expect(state.lastError).toBeNull();
  });
});

describe("isInspectableRuntimeEvent", () => {
  it("hides streamed message deltas from inspector activity", () => {
    expect(
      isInspectableRuntimeEvent(
        event(1, "message.delta", { messageId: "msg_assistant", delta: "Hello" }),
      ),
    ).toBe(false);
    expect(isInspectableRuntimeEvent(event(2, "tool.started", { toolCallId: "call_1" }))).toBe(
      true,
    );
  });
});

describe("buildRuntimeToolCallsForMessage", () => {
  it("groups live tool lifecycle events by assistant message", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "read_file",
          input: { path: "README.md" },
        }),
        event(2, "tool.completed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "read_file",
          output: { content: "Hello" },
        }),
        event(3, "tool.started", {
          messageId: "other_message",
          toolCallId: "call_2",
          name: "write_file",
          input: { path: "ignored.ts" },
        }),
      ],
      "msg_assistant",
    );

    expect(calls).toEqual([
      {
        id: "call_1",
        name: "read_file",
        status: "completed",
        inputPreview: '{\n  "path": "README.md"\n}',
        activityPreview: "",
        outputPreview: '{\n  "content": "Hello"\n}',
        startedEventId: 1,
        completedEventId: 2,
      },
    ]);
  });

  it("keeps streamed tool input visible before the full input is available", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        {
          ...event(10, "tool.delta", {
            toolCallId: "call_1",
            delta: '{"path"',
          }),
          messageId: "msg_assistant",
        },
        {
          ...event(11, "tool.delta", {
            toolCallId: "call_1",
            delta: ':"README.md"}',
          }),
          messageId: "msg_assistant",
        },
      ],
      "msg_assistant",
    );

    expect(calls).toMatchObject([
      {
        id: "call_1",
        name: "Tool call",
        status: "running",
        inputPreview: '{"path":"README.md"}',
      },
    ]);
  });

  it("attaches live command output to the matching running tool", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "exec_command",
          input: { cmd: "bun test" },
        }),
        {
          ...event(2, "command.output", {
            command: "exec_command",
            toolCallId: "call_1",
            stream: "stdout",
            delta: "PASS runtime-events.test.ts\n",
          }),
          messageId: "msg_assistant",
        },
      ],
      "msg_assistant",
    );

    expect(calls).toMatchObject([
      {
        id: "call_1",
        activityPreview: "PASS runtime-events.test.ts",
      },
    ]);
  });
});

describe("buildAssistantTurnParts", () => {
  it("uses AI SDK assistant content parts to place tool calls in the turn", () => {
    const parts = buildAssistantTurnParts(
      {
        id: "msg_assistant",
        role: "assistant",
        content: "Before after",
        status: "completed",
        modelMessage: {
          role: "assistant",
          content: [
            { type: "text", text: "Before" },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "read_file",
              input: { path: "README.md" },
            },
            { type: "text", text: "After" },
          ],
        },
      },
      [
        event(1, "tool.completed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "read_file",
          output: { content: "Docs" },
        }),
      ],
    );

    expect(parts).toEqual([
      { type: "text", text: "Before" },
      {
        type: "tool-call",
        toolCall: {
          id: "call_1",
          name: "read_file",
          status: "completed",
          inputPreview: '{\n  "path": "README.md"\n}',
          activityPreview: "",
          outputPreview: '{\n  "content": "Docs"\n}',
          startedEventId: null,
          completedEventId: 1,
        },
      },
      { type: "text", text: "After" },
    ]);
  });

  it("falls back to runtime event order while the assistant message is streaming", () => {
    const parts = buildAssistantTurnParts(
      {
        id: "msg_assistant",
        role: "assistant",
        content: "BeforeAfter",
        status: "running",
      },
      [
        event(1, "message.delta", { messageId: "msg_assistant", delta: "Before" }),
        event(2, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "read_file",
          input: { path: "README.md" },
        }),
        event(3, "message.delta", { messageId: "msg_assistant", delta: "After" }),
      ],
    );

    expect(parts.map((part) => part.type)).toEqual(["text", "tool-call", "text"]);
  });

  it("reads tool result details from persisted AI SDK tool messages", () => {
    const assistantMessage = {
      id: "msg_assistant",
      role: "assistant",
      content: "",
      status: "completed",
      modelMessage: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "read_file",
            input: { path: "README.md" },
          },
        ],
      },
    };

    const parts = buildAssistantTurnParts(
      assistantMessage,
      [],
      [
        assistantMessage,
        {
          id: "msg_tool",
          role: "tool",
          content: "",
          status: "completed",
          toolCallId: "call_1",
          modelMessage: {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "read_file",
                output: { type: "json", value: { content: "Docs" } },
              },
            ],
          },
        },
      ],
    );

    expect(parts).toMatchObject([
      {
        type: "tool-call",
        toolCall: {
          id: "call_1",
          outputPreview: '{\n  "content": "Docs"\n}',
        },
      },
    ]);
  });
});

function event(id: number, type: string, payload: Record<string, unknown>): RuntimeEvent {
  return { id, type, payload, messageId: null };
}
