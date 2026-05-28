import { describe, expect, it } from "vitest";
import {
  applyRuntimeEventToState,
  buildAssistantTurnParts,
  buildBackgroundActivityParts,
  buildRuntimeToolCallsForMessage,
  emptyCostSummary,
  emptyUsageSummary,
  isInspectableRuntimeEvent,
  type RuntimeEvent,
  type SessionMessage,
  type SessionRuntimeState,
} from "./runtime-events";

function initialState(): SessionRuntimeState {
  return {
    events: [],
    messages: [{ id: "msg_user", role: "user", content: "Hi", status: "completed" }],
    usage: emptyUsageSummary(),
    toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
    cost: emptyCostSummary(),
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

    expect(state.messages.find((message) => message.id === "msg_assistant")).toMatchObject({
      id: "msg_assistant",
      role: "assistant",
      content: "Hello there",
      status: "completed",
    });
  });

  it("stores completed assistant model parts so live tool turns render final text", () => {
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
      event(2, "tool.completed", {
        messageId: "msg_assistant",
        toolCallId: "call_exa",
        name: "exa_search",
        output: { results: [] },
      }),
    );
    state = applyRuntimeEventToState(
      state,
      event(3, "message.completed", {
        messageId: "msg_assistant",
        content: "Here is the answer.",
        modelMessage: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call_exa",
              toolName: "exa_search",
              input: { query: "test" },
            },
            { type: "text", text: "Here is the answer." },
          ],
        },
      }),
    );

    const assistant = state.messages.find((message) => message.id === "msg_assistant");
    expect(assistant?.modelMessage).toMatchObject({ role: "assistant" });
    expect(buildAssistantTurnParts(assistant!, state.events, state.messages)).toEqual([
      expect.objectContaining({
        type: "tool-call",
        toolCall: expect.objectContaining({ id: "call_exa", status: "completed" }),
      }),
      { type: "text", text: "Here is the answer." },
    ]);
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

  it("uses content and completed status from user message created events", () => {
    const state = applyRuntimeEventToState(
      initialState(),
      event(1, "message.created", {
        messageId: "msg_new_user",
        role: "user",
        content: "Please ship this",
        status: "completed",
      }),
    );

    expect(state.messages.find((message) => message.id === "msg_new_user")).toMatchObject({
      id: "msg_new_user",
      role: "user",
      content: "Please ship this",
      status: "completed",
    });
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

  it("stops running assistant messages when the session fails", () => {
    let state = applyRuntimeEventToState(
      initialState(),
      event(1, "message.created", {
        messageId: "msg_assistant",
        role: "assistant",
      }),
    );

    state = applyRuntimeEventToState(state, event(2, "session.error", { message: "Gateway down" }));

    expect(state.messages.find((message) => message.id === "msg_assistant")).toMatchObject({
      status: "failed",
      completedAt: expect.any(String),
      thinkingDurationSeconds: expect.any(Number),
    });
  });

  it("adds live usage events to the session usage summary", () => {
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
      event(2, "session.usage", {
        inputTokens: 100,
        inputNoCacheTokens: 60,
        inputCacheReadTokens: 30,
        inputCacheWriteTokens: 10,
        outputTokens: 25,
        outputTextTokens: 20,
        outputReasoningTokens: 5,
        totalTokens: 125,
      }),
    );
    state = applyRuntimeEventToState(
      state,
      event(3, "session.usage", {
        messageId: "msg_assistant",
        inputTokens: 40,
        inputNoCacheTokens: 35,
        inputCacheReadTokens: 5,
        inputCacheWriteTokens: 0,
        outputTokens: 10,
        outputTextTokens: 8,
        outputReasoningTokens: 2,
        totalTokens: 50,
      }),
    );

    expect(state.usage).toEqual({
      inputTokens: 140,
      inputNoCacheTokens: 95,
      inputCacheReadTokens: 35,
      inputCacheWriteTokens: 10,
      outputTokens: 35,
      outputTextTokens: 28,
      outputReasoningTokens: 7,
      totalTokens: 175,
    });
    expect(state.messages.find((message) => message.id === "msg_assistant")).toMatchObject({
      outputReasoningTokens: 2,
    });
  });

  it("adds live hosted tool usage events to the cost summary", () => {
    let state = initialState();
    state = applyRuntimeEventToState(
      state,
      event(1, "session.tool_usage", {
        provider: "exa",
        operation: "search",
        costUsdMicros: 7000,
      }),
    );
    state = applyRuntimeEventToState(
      state,
      event(2, "session.tool_usage", {
        provider: "exa",
        operation: "search",
        costUsdMicros: 3000,
      }),
    );

    expect(state.toolUsage).toEqual({
      totalCostUsdMicros: 10000,
      byProviderOperation: [
        { provider: "exa", operation: "search", costUsdMicros: 10000, calls: 2 },
      ],
    });
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

  it("marks failed tool lifecycle events with the error preview", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "read_file",
          input: { path: "README.md" },
        }),
        event(2, "tool.failed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "read_file",
          error: {
            message: "Path must be inside work/ or brain/ for this session.",
            code: "invalid_sandbox_path",
            recoverable: true,
          },
        }),
      ],
      "msg_assistant",
    );

    expect(calls).toMatchObject([
      {
        id: "call_1",
        name: "read_file",
        status: "failed",
        outputPreview: expect.stringContaining("invalid_sandbox_path"),
      },
    ]);
  });

  it("marks the latest orphan running tool as failed when an old session has only session error", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "read_file",
          input: { path: "README.md" },
        }),
        event(2, "session.error", {
          message: "Path must be inside work/ or brain/ for this session.",
        }),
      ],
      "msg_assistant",
    );

    expect(calls).toMatchObject([
      {
        id: "call_1",
        status: "failed",
        outputPreview: expect.stringContaining("Path must be inside work/ or brain/"),
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

  it("marks write_file calls that update brain paths", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "write_file",
          input: { path: "brain/foo.md", content: "Updated notes" },
        }),
        event(2, "file.changed", {
          messageId: "msg_assistant",
          path: "brain/foo.md",
          operation: "write",
        }),
        event(3, "tool.completed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "write_file",
          output: { path: "brain/foo.md", bytes: 13 },
        }),
      ],
      "msg_assistant",
    );

    expect(calls).toMatchObject([
      {
        id: "call_1",
        name: "write_file",
        brainPath: "foo.md",
      },
    ]);
  });

  it("leaves normal write_file calls unmarked", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "write_file",
          input: { path: "src/foo.ts", content: "export {};" },
        }),
        event(2, "tool.completed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "write_file",
          output: { path: "src/foo.ts", bytes: 10 },
        }),
      ],
      "msg_assistant",
    );

    expect(calls[0]?.brainPath).toBeUndefined();
  });

  it("marks edit_file calls that update brain paths", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "edit_file",
          input: {
            path: "brain/foo.md",
            instructions: "Update durable notes.",
            edits: [{ oldString: "Old", newString: "New" }],
          },
        }),
        event(2, "file.changed", {
          messageId: "msg_assistant",
          path: "brain/foo.md",
          operation: "write",
        }),
        event(3, "tool.completed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "edit_file",
          output: { path: "brain/foo.md", editsApplied: 1, replacements: 1, bytes: 3 },
        }),
      ],
      "msg_assistant",
    );

    expect(calls).toMatchObject([
      {
        id: "call_1",
        name: "edit_file",
        brainPath: "foo.md",
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

  it("prepends persisted reasoning summaries without mixing them into visible text", () => {
    const parts = buildAssistantTurnParts(
      {
        id: "msg_assistant",
        role: "assistant",
        content: "Final answer",
        status: "completed",
        modelMessage: {
          role: "assistant",
          content: "Final answer",
        },
      },
      [
        event(1, "message.reasoning_summary", {
          messageId: "msg_assistant",
          summary: "Checked the relevant files first.",
        }),
      ],
    );

    expect(parts).toEqual([
      { type: "reasoning", text: "Checked the relevant files first.", durationSeconds: 1 },
      { type: "text", text: "Final answer" },
    ]);
  });

  it("shows a reasoning marker with turn duration when usage has reasoning tokens but no summary", () => {
    const parts = buildAssistantTurnParts(
      {
        id: "msg_assistant",
        role: "assistant",
        content: "Final answer",
        status: "completed",
        outputReasoningTokens: 74,
        createdAt: "2026-05-22T13:00:00.000Z",
        completedAt: "2026-05-22T13:00:03.400Z",
        modelMessage: {
          role: "assistant",
          content: "Final answer",
        },
      },
      [],
    );

    expect(parts).toEqual([
      { type: "reasoning", durationSeconds: 3, text: undefined },
      { type: "text", text: "Final answer" },
    ]);
  });

  it("adds live thinking duration when completion arrives after reasoning usage", () => {
    let state = initialState();
    state = applyRuntimeEventToState(
      state,
      event(1, "message.created", {
        messageId: "msg_assistant",
        role: "assistant",
      }),
    );

    const createdAt = state.messages.find((message) => message.id === "msg_assistant")?.createdAt;
    state = applyRuntimeEventToState(
      state,
      event(2, "session.usage", {
        messageId: "msg_assistant",
        inputTokens: 100,
        outputTokens: 25,
        outputTextTokens: 20,
        outputReasoningTokens: 5,
        totalTokens: 125,
      }),
    );
    state = applyRuntimeEventToState(
      state,
      event(3, "message.completed", {
        messageId: "msg_assistant",
        content: "Done",
      }),
    );

    expect(state.messages.find((message) => message.id === "msg_assistant")).toMatchObject({
      createdAt,
      completedAt: expect.any(String),
      thinkingDurationSeconds: expect.any(Number),
    });
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

  it("marks persisted write_file model parts for brain paths", () => {
    const parts = buildAssistantTurnParts(
      {
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
              toolName: "write_file",
              input: { path: "brain/foo.md", content: "Updated notes" },
            },
          ],
        },
      },
      [],
    );

    expect(parts).toMatchObject([
      {
        type: "tool-call",
        toolCall: {
          id: "call_1",
          name: "write_file",
          brainPath: "foo.md",
        },
      },
    ]);
  });
});

describe("buildBackgroundActivityParts", () => {
  it("groups after-session lifecycle events into one completed tool call row", () => {
    const parts = buildBackgroundActivityParts(
      [
        event(1, "after_session.started", {
          runId: 12,
          messageId: "msg_user",
          idleDelaySeconds: 180,
        }),
        event(2, "after_session.completed", {
          runId: 12,
          messageId: "msg_user",
        }),
      ],
      [],
    );

    expect(parts).toEqual([
      {
        type: "tool-call",
        toolCall: {
          id: "after-session:12",
          name: "after_session",
          status: "completed",
          inputPreview: "",
          activityPreview: "",
          outputPreview: "Completed",
          startedEventId: 1,
          completedEventId: 2,
        },
      },
    ]);
  });

  it("does not surface skipped older after-session checks as chat activity", () => {
    const parts = buildBackgroundActivityParts(
      [
        event(1, "after_session.skipped", {
          messageId: "msg_old",
          reason: "newer_message",
        }),
      ],
      [],
    );

    expect(parts).toEqual([]);
  });

  it("reconciles after-session lifecycle events by message id when an older event has no run id", () => {
    const parts = buildBackgroundActivityParts(
      [
        event(1, "after_session.started", {
          messageId: "msg_user",
          idleDelaySeconds: 180,
        }),
        event(2, "after_session.completed", {
          runId: 12,
          messageId: "msg_user",
        }),
      ],
      [],
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      type: "tool-call",
      toolCall: {
        status: "completed",
        startedEventId: 1,
        completedEventId: 2,
      },
    });
  });

  it("reuses assistant tool-call rendering data for internal after-session tool calls", () => {
    const assistantMessage = {
      id: "msg_internal",
      role: "assistant",
      content: "",
      status: "completed",
      internal: true,
      modelMessage: {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "write_file",
            input: { path: "brain/memory.md", content: "Preference saved" },
          },
        ],
      },
    } satisfies SessionMessage;

    const parts = buildBackgroundActivityParts(
      [
        event(1, "after_session.started", {
          runId: 12,
          messageId: "msg_user",
          idleDelaySeconds: 180,
        }),
        event(2, "tool.started", {
          messageId: "msg_internal",
          toolCallId: "call_1",
          name: "write_file",
          input: { path: "brain/memory.md", content: "Preference saved" },
        }),
        event(3, "file.changed", {
          messageId: "msg_internal",
          path: "brain/memory.md",
          operation: "write",
        }),
        event(4, "tool.completed", {
          messageId: "msg_internal",
          toolCallId: "call_1",
          name: "write_file",
          output: { path: "brain/memory.md", bytes: 16 },
        }),
        event(5, "after_session.completed", {
          runId: 12,
          messageId: "msg_user",
        }),
      ],
      [assistantMessage],
    );

    expect(parts).toMatchObject([
      {
        type: "tool-call",
        toolCall: {
          id: "after-session:12",
          name: "after_session",
          status: "completed",
        },
      },
      {
        type: "tool-call",
        toolCall: {
          id: "call_1",
          name: "write_file",
          status: "completed",
          brainPath: "memory.md",
        },
      },
    ]);
  });
});

function event(id: number, type: string, payload: Record<string, unknown>): RuntimeEvent {
  return { id, type, payload, messageId: null };
}
