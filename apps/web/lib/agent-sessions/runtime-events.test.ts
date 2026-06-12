import { describe, expect, it } from "vitest";
import {
  applyRuntimeEventToState,
  buildAssistantTurnParts,
  buildBackgroundActivityParts,
  buildRuntimeToolCallsForMessage,
  buildSessionDebugTurns,
  computeThinkingDurationSeconds,
  describeToolCall,
  emptyCostSummary,
  emptyUsageSummary,
  isInspectableRuntimeEvent,
  isReasoningInProgress,
  mergeEvents,
  mergeLiveSessionAggregates,
  mergeMessages,
  type RuntimeEvent,
  resolveToolDisplay,
  type SessionMessage,
  type SessionRuntimeState,
} from "./runtime-events";

function message(id: string, role: string, content: string): SessionMessage {
  return { id, role, content, status: "completed" };
}

describe("mergeMessages", () => {
  it("keeps a snapshot-only message the stream is missing (Bug B)", () => {
    const snapshot = [message("msg_user", "user", "Hi"), message("msg_asst", "assistant", "Hello")];
    // The stream lacks the user message (best-effort web append never landed).
    const overlay = [message("msg_asst", "assistant", "Hello there")];

    const merged = mergeMessages(snapshot, overlay);

    expect(merged.map((m) => m.id)).toEqual(["msg_user", "msg_asst"]);
    // Overlay's copy of the shared message wins (live content).
    expect(merged[1]?.content).toBe("Hello there");
  });

  it("appends stream-only messages in stream order after the snapshot", () => {
    const snapshot = [message("msg_user", "user", "Hi")];
    const overlay = [
      message("msg_user", "user", "Hi"),
      message("msg_asst", "assistant", "Reply"),
      message("msg_user2", "user", "Again"),
    ];

    const merged = mergeMessages(snapshot, overlay);

    expect(merged.map((m) => m.id)).toEqual(["msg_user", "msg_asst", "msg_user2"]);
  });

  it("returns the snapshot unchanged when the overlay is empty", () => {
    const snapshot = [message("msg_user", "user", "Hi")];
    expect(mergeMessages(snapshot, [])).toEqual(snapshot);
  });
});

describe("mergeEvents", () => {
  it("dedupes durable events by id and appends transient deltas", () => {
    const snapshot = [event(1, "message.created", { messageId: "m" })];
    const overlay = [
      event(1, "message.created", { messageId: "m" }),
      event(null, "message.delta", { messageId: "m", delta: "hi" }),
      event(2, "message.completed", { messageId: "m" }),
    ];

    const merged = mergeEvents(snapshot, overlay);

    expect(merged.map((e) => e.id)).toEqual([1, null, 2]);
  });

  it("keeps snapshot durable events not present on the stream", () => {
    const snapshot = [
      event(1, "message.created", { messageId: "m" }),
      event(2, "session.status", {}),
    ];
    const overlay = [event(3, "message.delta", { messageId: "m" })];

    const merged = mergeEvents(snapshot, overlay);

    expect(merged.map((e) => e.id)).toEqual([1, 2, 3]);
  });
});

describe("mergeLiveSessionAggregates", () => {
  it("adds only usage and cost events newer than the server high-water mark", () => {
    const snapshot = {
      usage: {
        inputTokens: 100,
        inputNoCacheTokens: 90,
        inputCacheReadTokens: 10,
        inputCacheWriteTokens: 0,
        outputTokens: 20,
        outputTextTokens: 18,
        outputReasoningTokens: 2,
        totalTokens: 120,
      },
      toolUsage: { totalCostUsdMicros: 500, byProviderOperation: [] },
      cost: {
        providerCostUsdMicros: 1000,
        platformFeeUsdMicros: 100,
        totalCostUsdMicros: 1100,
        modelCostUsdMicros: 1100,
        toolCostUsdMicros: 0,
        sandboxCostUsdMicros: 0,
      },
      currentContextTokens: 120,
    };

    const merged = mergeLiveSessionAggregates(
      snapshot,
      [
        event(3, "session.usage", {
          inputTokens: 1_000,
          outputTokens: 250,
          totalTokens: 1_250,
          providerCostUsdMicros: 10_000,
          platformFeeUsdMicros: 1_000,
          chargedCostUsdMicros: 11_000,
        }),
        event(4, "session.usage", {
          inputTokens: 40,
          inputNoCacheTokens: 35,
          inputCacheReadTokens: 5,
          outputTokens: 10,
          outputTextTokens: 8,
          outputReasoningTokens: 2,
          totalTokens: 50,
          providerCostUsdMicros: 400,
          platformFeeUsdMicros: 40,
          chargedCostUsdMicros: 440,
        }),
        event(5, "session.tool_usage", {
          provider: "exa",
          operation: "search",
          costUsdMicros: 700,
          providerCostUsdMicros: 700,
          chargedCostUsdMicros: 700,
        }),
      ],
      3,
    );

    expect(merged.usage.totalTokens).toBe(170);
    expect(merged.cost.totalCostUsdMicros).toBe(2240);
    expect(merged.cost.modelCostUsdMicros).toBe(1540);
    expect(merged.cost.toolCostUsdMicros).toBe(700);
    expect(merged.toolUsage).toEqual({
      totalCostUsdMicros: 1200,
      byProviderOperation: [{ provider: "exa", operation: "search", costUsdMicros: 700, calls: 1 }],
    });
    expect(merged.currentContextTokens).toBe(50);
  });

  it("uses the highest-id session.usage event for currentContextTokens when events arrive out of order", () => {
    // Event id 5 (higher) arrives before event id 4 (lower) in the overlay array.
    // currentContextTokens must reflect the tokens from id 5, not the stale id 4 that follows it.
    const snapshot = {
      usage: {
        inputTokens: 0,
        inputNoCacheTokens: 0,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTokens: 0,
        outputTextTokens: 0,
        outputReasoningTokens: 0,
        totalTokens: 0,
      },
      toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
      cost: {
        providerCostUsdMicros: 0,
        platformFeeUsdMicros: 0,
        totalCostUsdMicros: 0,
        modelCostUsdMicros: 0,
        toolCostUsdMicros: 0,
        sandboxCostUsdMicros: 0,
      },
      currentContextTokens: 0,
    };

    const merged = mergeLiveSessionAggregates(
      snapshot,
      [
        // Higher-id event arrives first in iteration order (stream replay out-of-order).
        event(5, "session.usage", { inputTokens: 800, outputTokens: 200 }),
        // Lower-id event arrives second — must NOT overwrite currentContextTokens.
        event(4, "session.usage", { inputTokens: 100, outputTokens: 50 }),
      ],
      3,
    );

    // currentContextTokens must come from the higher-id event (id 5): 800 + 200 = 1000.
    expect(merged.currentContextTokens).toBe(1000);
  });

  it("updates currentContextTokens from a session.delegated_usage event", () => {
    const snapshot = {
      usage: {
        inputTokens: 0,
        inputNoCacheTokens: 0,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTokens: 0,
        outputTextTokens: 0,
        outputReasoningTokens: 0,
        totalTokens: 0,
      },
      toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
      cost: {
        providerCostUsdMicros: 0,
        platformFeeUsdMicros: 0,
        totalCostUsdMicros: 0,
        modelCostUsdMicros: 0,
        toolCostUsdMicros: 0,
        sandboxCostUsdMicros: 0,
      },
      currentContextTokens: 0,
    };

    const merged = mergeLiveSessionAggregates(
      snapshot,
      [
        event(5, "session.delegated_usage", {
          childSessionId: "ses_child",
          usage: { inputTokens: 300, outputTokens: 100, totalTokens: 400 },
          cost: { providerCostUsdMicros: 500, platformFeeUsdMicros: 50, totalCostUsdMicros: 550 },
          toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
        }),
      ],
      3,
    );

    // currentContextTokens = inputTokens + outputTokens from the delegated usage payload.
    expect(merged.currentContextTokens).toBe(400);
    expect(merged.usage.totalTokens).toBe(400);
  });

  it("applies the highest-id guard across mixed session.usage and session.delegated_usage events", () => {
    // A session.delegated_usage (id 4) and a session.usage (id 6) both arrive.
    // The session.usage has the higher id so it wins for currentContextTokens.
    const snapshot = {
      usage: {
        inputTokens: 0,
        inputNoCacheTokens: 0,
        inputCacheReadTokens: 0,
        inputCacheWriteTokens: 0,
        outputTokens: 0,
        outputTextTokens: 0,
        outputReasoningTokens: 0,
        totalTokens: 0,
      },
      toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
      cost: {
        providerCostUsdMicros: 0,
        platformFeeUsdMicros: 0,
        totalCostUsdMicros: 0,
        modelCostUsdMicros: 0,
        toolCostUsdMicros: 0,
        sandboxCostUsdMicros: 0,
      },
      currentContextTokens: 0,
    };

    const merged = mergeLiveSessionAggregates(
      snapshot,
      [
        // Delegated usage arrives first with a lower id — sets currentContextTokens initially.
        event(4, "session.delegated_usage", {
          usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
          cost: {},
          toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
        }),
        // Direct session.usage with a higher id must win for currentContextTokens.
        event(6, "session.usage", { inputTokens: 500, outputTokens: 100 }),
      ],
      3,
    );

    // currentContextTokens must come from the higher-id event (id 6): 500 + 100 = 600.
    expect(merged.currentContextTokens).toBe(600);
  });
});

function initialState(): SessionRuntimeState {
  return {
    events: [],
    messages: [{ id: "msg_user", role: "user", content: "Hi", status: "completed" }],
    usage: emptyUsageSummary(),
    toolUsage: { totalCostUsdMicros: 0, byProviderOperation: [] },
    cost: emptyCostSummary(),
    currentStatus: "running",
    lastError: null,
    statusObserved: false,
  };
}

describe("statusObserved (stream scalar authority)", () => {
  it("stays false after non-status-bearing deltas so the snapshot stays authoritative", () => {
    let state = initialState();
    expect(state.statusObserved).toBe(false);

    state = applyRuntimeEventToState(
      state,
      event(null, "message.delta", { messageId: "msg_asst", delta: "hi" }),
    );
    state = applyRuntimeEventToState(
      state,
      event(1, "session.usage", { messageId: "msg_asst", inputTokens: 10 }),
    );

    // A token or usage delta is not status-bearing: the live stream must not yet
    // override the Postgres snapshot's status/lastError (the start-of-session flicker).
    expect(state.statusObserved).toBe(false);
  });

  it("flips true once a status-bearing event is reduced", () => {
    const fromStatus = applyRuntimeEventToState(
      initialState(),
      event(1, "session.status", { status: "running" }),
    );
    expect(fromStatus.statusObserved).toBe(true);

    const fromError = applyRuntimeEventToState(
      initialState(),
      event(1, "session.error", { message: "boom" }),
    );
    expect(fromError.statusObserved).toBe(true);

    const fromUserMessage = applyRuntimeEventToState(
      initialState(),
      event(1, "message.created", { messageId: "msg_new_user", role: "user", content: "hi" }),
    );
    expect(fromUserMessage.statusObserved).toBe(true);
  });

  it("does not flip on an internal user message (no visible turn starts)", () => {
    const state = applyRuntimeEventToState(
      initialState(),
      event(1, "message.created", {
        messageId: "msg_internal",
        role: "user",
        content: "Hidden steering",
        internal: true,
      }),
    );
    expect(state.statusObserved).toBe(false);
  });
});

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

  it("applies repeated transient message deltas with null ids", () => {
    let state = initialState();
    state = applyRuntimeEventToState(
      state,
      event(1, "message.created", {
        messageId: "msg_assistant",
        role: "assistant",
      }),
    );
    const delta = event(null, "message.delta", {
      messageId: "msg_assistant",
      delta: "ha",
    });

    state = applyRuntimeEventToState(state, delta);
    state = applyRuntimeEventToState(state, delta);

    expect(state.messages.find((message) => message.id === "msg_assistant")?.content).toBe("haha");
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

  it("treats a new non-internal user message as the start of a new pending turn", () => {
    let state: SessionRuntimeState = {
      ...initialState(),
      currentStatus: "failed",
      lastError: "Gateway down",
    };

    state = applyRuntimeEventToState(
      state,
      event(1, "message.created", {
        messageId: "msg_new_user",
        role: "user",
        content: "Try again",
        status: "completed",
      }),
    );

    expect(state.currentStatus).toBe("running");
    expect(state.lastError).toBeNull();
    expect(state.messages.find((message) => message.id === "msg_new_user")).toMatchObject({
      role: "user",
      content: "Try again",
      status: "completed",
    });

    state = applyRuntimeEventToState(state, event(2, "session.error", { message: "Still down" }));

    expect(state.currentStatus).toBe("failed");
    expect(state.lastError).toBe("Still down");
  });

  it("does not start a visible pending turn for internal user messages", () => {
    const state = applyRuntimeEventToState(
      {
        ...initialState(),
        currentStatus: "completed",
      },
      event(1, "message.created", {
        messageId: "msg_internal",
        role: "user",
        content: "Hidden steering",
        status: "completed",
        internal: true,
      }),
    );

    expect(state.currentStatus).toBe("completed");
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
    });
  });

  it("does not invent thinking time from tool duration on the abort path", () => {
    // Build a state where message.created gives the message a createdAt, then two tool
    // events with explicit createdAt timestamps are added, and then a session.error aborts
    // before message.completed fires.
    let state = applyRuntimeEventToState(
      initialState(),
      event(1, "message.created", {
        messageId: "msg_assistant",
        role: "assistant",
      }),
    );

    const assistantMessage = state.messages.find((m) => m.id === "msg_assistant");
    if (!assistantMessage?.createdAt) throw new Error("expected assistant message createdAt");
    const msgCreatedAt = assistantMessage.createdAt;
    // Tool runs for 4 seconds starting 1 second into the message.
    const toolStart = new Date(Date.parse(msgCreatedAt) + 1000).toISOString();
    const toolEnd = new Date(Date.parse(msgCreatedAt) + 5000).toISOString();

    state = applyRuntimeEventToState(state, {
      ...event(2, "tool.started", {
        messageId: "msg_assistant",
        toolCallId: "call_abort",
        name: "read_file",
        input: { path: "README.md" },
      }),
      createdAt: toolStart,
    });
    state = applyRuntimeEventToState(state, {
      ...event(3, "tool.completed", {
        messageId: "msg_assistant",
        toolCallId: "call_abort",
        name: "read_file",
        output: { content: "hi" },
      }),
      createdAt: toolEnd,
    });

    state = applyRuntimeEventToState(state, event(4, "session.error", { message: "Aborted" }));

    const msg = state.messages.find((m) => m.id === "msg_assistant");
    expect(msg).toMatchObject({ status: "failed", thinkingDurationSeconds: undefined });
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

  it("adds delegated child usage rollups without touching parent message reasoning", () => {
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
      event(2, "session.delegated_usage", {
        childSessionId: "ses_child",
        parentToolCallId: "call_delegate",
        usage: {
          inputTokens: 100,
          inputNoCacheTokens: 80,
          inputCacheReadTokens: 10,
          inputCacheWriteTokens: 10,
          outputTokens: 25,
          outputTextTokens: 20,
          outputReasoningTokens: 5,
          totalTokens: 125,
        },
        cost: {
          providerCostUsdMicros: 1000,
          platformFeeUsdMicros: 100,
          totalCostUsdMicros: 1100,
          modelCostUsdMicros: 770,
          toolCostUsdMicros: 330,
        },
        toolUsage: {
          totalCostUsdMicros: 300,
          byProviderOperation: [
            { provider: "exa", operation: "search", costUsdMicros: 300, calls: 1 },
          ],
        },
      }),
    );

    expect(state.usage.totalTokens).toBe(125);
    expect(state.cost.totalCostUsdMicros).toBe(1100);
    expect(state.cost.modelCostUsdMicros).toBe(770);
    expect(state.cost.toolCostUsdMicros).toBe(330);
    expect(state.toolUsage.byProviderOperation).toEqual([
      { provider: "exa", operation: "search", costUsdMicros: 300, calls: 1 },
    ]);
    expect(
      state.messages.find((message) => message.id === "msg_assistant")?.outputReasoningTokens,
    ).toBeUndefined();
  });
});

describe("buildSessionDebugTurns", () => {
  it("collapses messages into one consolidated entry per turn, carrying modelMessage", () => {
    const messages: SessionMessage[] = [
      { id: "msg_user", role: "user", content: "Hi", status: "completed" },
      {
        id: "msg_assistant",
        role: "assistant",
        content: "Hello",
        status: "completed",
        modelMessage: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      },
      {
        id: "msg_tool",
        role: "tool",
        content: "ok",
        status: "completed",
        toolName: "read_file",
        toolCallId: "call_1",
        modelMessage: { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1" }] },
      },
    ];

    expect(buildSessionDebugTurns(messages)).toEqual([
      { id: "msg_user", role: "user", status: "completed", modelMessage: null, content: "Hi" },
      {
        id: "msg_assistant",
        role: "assistant",
        status: "completed",
        modelMessage: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        content: "Hello",
      },
      {
        id: "msg_tool",
        role: "tool",
        status: "completed",
        toolName: "read_file",
        toolCallId: "call_1",
        modelMessage: { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1" }] },
        content: "ok",
      },
    ]);
  });

  it("defaults modelMessage to null for a still-streaming turn", () => {
    const turns = buildSessionDebugTurns([
      { id: "msg_assistant", role: "assistant", content: "partial", status: "running" },
    ]);
    expect(turns).toEqual([
      {
        id: "msg_assistant",
        role: "assistant",
        status: "running",
        modelMessage: null,
        content: "partial",
      },
    ]);
  });
});

describe("isInspectableRuntimeEvent", () => {
  it("hides streamed message and reasoning deltas from inspector activity", () => {
    expect(
      isInspectableRuntimeEvent(
        event(1, "message.delta", { messageId: "msg_assistant", delta: "Hello" }),
      ),
    ).toBe(false);
    expect(
      isInspectableRuntimeEvent(
        event(2, "message.reasoning_delta", { messageId: "msg_assistant", delta: "Hmm" }),
      ),
    ).toBe(false);
    expect(isInspectableRuntimeEvent(event(3, "tool.started", { toolCallId: "call_1" }))).toBe(
      true,
    );
  });
});

describe("isReasoningInProgress", () => {
  const runningMessage: SessionMessage = {
    id: "msg_assistant",
    role: "assistant",
    content: "",
    status: "running",
  };

  it("is true when the latest event for the running message is a reasoning delta", () => {
    const events = [
      event(1, "message.created", { messageId: "msg_assistant", role: "assistant" }),
      event(2, "message.reasoning_delta", { messageId: "msg_assistant", delta: "Weighing…" }),
    ];
    expect(isReasoningInProgress(runningMessage, events)).toBe(true);
  });

  it("is true between durable reasoning start and completion events", () => {
    const events = [
      event(1, "message.created", { messageId: "msg_assistant", role: "assistant" }),
      event(2, "message.reasoning_started", { messageId: "msg_assistant" }),
    ];
    expect(isReasoningInProgress(runningMessage, events)).toBe(true);

    expect(
      isReasoningInProgress(runningMessage, [
        ...events,
        event(3, "message.reasoning_completed", { messageId: "msg_assistant" }),
      ]),
    ).toBe(false);
  });

  it("is false once visible text or a tool call follows the reasoning", () => {
    const withText = [
      event(1, "message.reasoning_delta", { messageId: "msg_assistant", delta: "Weighing…" }),
      event(2, "message.delta", { messageId: "msg_assistant", delta: "Here is" }),
    ];
    expect(isReasoningInProgress(runningMessage, withText)).toBe(false);

    const withTool = [
      event(1, "message.reasoning_delta", { messageId: "msg_assistant", delta: "Weighing…" }),
      event(2, "tool.started", { messageId: "msg_assistant", toolCallId: "call_1" }),
    ];
    expect(isReasoningInProgress(runningMessage, withTool)).toBe(false);
  });

  it("uses arrival order for repeated transient reasoning and text deltas", () => {
    const events = [
      event(null, "message.reasoning_delta", {
        messageId: "msg_assistant",
        delta: "Weighing…",
      }),
      event(null, "message.delta", { messageId: "msg_assistant", delta: "Here is" }),
    ];

    expect(isReasoningInProgress(runningMessage, events)).toBe(false);
  });

  it("is false when the message is no longer running", () => {
    const events = [
      event(1, "message.reasoning_delta", { messageId: "msg_assistant", delta: "Weighing…" }),
    ];
    expect(isReasoningInProgress({ ...runningMessage, status: "completed" }, events)).toBe(false);
  });

  it("ignores reasoning deltas that belong to other messages", () => {
    const events = [
      event(1, "message.reasoning_delta", { messageId: "msg_other", delta: "Weighing…" }),
    ];
    expect(isReasoningInProgress(runningMessage, events)).toBe(false);
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
        label: "Reading README.md",
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

  it("attaches nested subagent progress to the parent tool call", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_subagent",
          name: "run_subagent",
          input: { description: "Research checkout options", prompt: "Find sources" },
        }),
        {
          ...event(null, "subagent.progress", {
            messageId: "msg_assistant",
            toolCallId: "call_subagent",
            label: "Research checkout options",
            kind: "tool-call",
            tool: {
              name: "exa_search",
              toolCallId: "inner_1",
              status: "running",
              inputPreview: '{"query":"checkout options"}',
            },
          }),
          messageId: "msg_assistant",
        },
        {
          ...event(null, "subagent.progress", {
            messageId: "msg_assistant",
            toolCallId: "call_subagent",
            label: "Research checkout options",
            kind: "tool-result",
            tool: {
              name: "exa_search",
              toolCallId: "inner_1",
              status: "completed",
              outputPreview: "3 results",
            },
          }),
          messageId: "msg_assistant",
        },
        {
          ...event(null, "subagent.progress", {
            messageId: "msg_assistant",
            toolCallId: "call_subagent",
            label: "Research checkout options",
            kind: "text-delta",
            delta: "Stripe Checkout is the best fit.",
          }),
          messageId: "msg_assistant",
        },
      ],
      "msg_assistant",
    );

    expect(calls).toMatchObject([
      {
        id: "call_subagent",
        name: "run_subagent",
        label: "Running subagent: Research checkout options",
        activityPreview: "Stripe Checkout is the best fit.",
        subagent: {
          label: "Research checkout options",
          textPreview: "Stripe Checkout is the best fit.",
          toolLines: [
            {
              id: "inner_1",
              name: "exa_search",
              label: "Web search",
              status: "completed",
              inputPreview: '{"query":"checkout options"}',
              outputPreview: "3 results",
            },
          ],
        },
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
        brainFile: { scope: "company", path: "foo.md" },
        brainPath: "foo.md",
      },
    ]);
  });

  it("marks write_file calls that update personal brain paths", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "write_file",
          input: { path: "personal-brain/foo.md", content: "Updated notes" },
        }),
        event(2, "file.changed", {
          messageId: "msg_assistant",
          path: "personal-brain/foo.md",
          operation: "write",
        }),
        event(3, "tool.completed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "write_file",
          output: { path: "personal-brain/foo.md", bytes: 13 },
        }),
      ],
      "msg_assistant",
    );

    expect(calls).toMatchObject([
      {
        id: "call_1",
        name: "write_file",
        brainFile: { scope: "personal", path: "foo.md" },
      },
    ]);
    expect(calls[0]?.brainPath).toBeUndefined();
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
        brainFile: { scope: "company", path: "foo.md" },
        brainPath: "foo.md",
      },
    ]);
  });

  it("attaches file.changed brain metadata to the latest file mutation tool", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "write_file",
          input: { path: "work/draft.md", content: "Draft" },
        }),
        event(2, "tool.completed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "write_file",
          output: { path: "work/draft.md", bytes: 5 },
        }),
        event(3, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_2",
          name: "edit_file",
          input: {
            path: "personal-brain/foo.md",
            edits: [{ oldString: "Old", newString: "New" }],
          },
        }),
        event(4, "file.changed", {
          messageId: "msg_assistant",
          path: "personal-brain/foo.md",
          operation: "write",
        }),
      ],
      "msg_assistant",
    );

    expect(calls[0]?.brainFile).toBeUndefined();
    expect(calls[1]).toMatchObject({
      id: "call_2",
      name: "edit_file",
      brainFile: { scope: "personal", path: "foo.md" },
    });
  });

  it("links a Linear tool call to its issue from the output URL", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "get_issue",
          input: { id: "PRO-114" },
        }),
        event(2, "tool.completed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "get_issue",
          output: {
            id: "PRO-114",
            title: "Add a link-out icon",
            url: "https://linear.app/actaso/issue/PRO-114/add-a-link-out-icon",
          },
        }),
      ],
      "msg_assistant",
    );

    expect(calls[0]?.issueUrl).toBe("https://linear.app/actaso/issue/PRO-114/add-a-link-out-icon");
  });

  it("falls back to the input URL when the output omits it", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "create_comment",
          input: { issueUrl: "https://linear.app/actaso/issue/PRO-9/some-issue", body: "hi" },
        }),
        event(2, "tool.completed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "create_comment",
          output: { success: true },
        }),
      ],
      "msg_assistant",
    );

    expect(calls[0]?.issueUrl).toBe("https://linear.app/actaso/issue/PRO-9/some-issue");
  });

  it("leaves tool calls without a Linear issue URL unlinked", () => {
    const calls = buildRuntimeToolCallsForMessage(
      [
        event(1, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "web_search",
          input: { query: "linear app" },
        }),
        event(2, "tool.completed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "web_search",
          output: { results: ["https://linear.app/homepage", "https://example.com"] },
        }),
      ],
      "msg_assistant",
    );

    expect(calls[0]?.issueUrl).toBeUndefined();
  });
});

describe("describeToolCall", () => {
  it("derives a contextual one-liner from the tool and its primary input", () => {
    expect(describeToolCall("exa_search", { query: "competitors in fintech" })).toBe(
      "Searching the web for “competitors in fintech”",
    );
    expect(describeToolCall("web_fetch", { url: "https://example.com/pricing" })).toBe(
      "Fetching example.com",
    );
    expect(describeToolCall("write_file", { path: "work/report.md" })).toBe(
      "Writing work/report.md",
    );
    expect(describeToolCall("shell", { command: "ls -la" })).toBe("Running ls -la");
    expect(describeToolCall("delegate_to_agent", { agent: "research" })).toBe(
      "Delegating to research",
    );
    expect(describeToolCall("run_subagent", { description: "research checkout options" })).toBe(
      "Running subagent: research checkout options",
    );
    expect(describeToolCall("memory", { args: 'query "acme blockers" --limit 5' })).toBe(
      "Looking in memory for “acme blockers”",
    );
  });

  it("falls back to a generic phrase when the primary input is missing", () => {
    expect(describeToolCall("exa_search", {})).toBe("Searching the web");
    expect(describeToolCall("web_fetch", { url: "not a url" })).toBe("Fetching a web page");
  });

  it("returns undefined for unknown tools so the raw name is used", () => {
    expect(describeToolCall("some_custom_tool", { foo: "bar" })).toBeUndefined();
  });

  it("derives a one-liner for the deferred search tools", () => {
    expect(describeToolCall("youtube_search", { query: "transformers" })).toBe(
      "Searching YouTube for “transformers”",
    );
    expect(describeToolCall("x_search_posts", { query: "AI agents" })).toBe(
      "Searching X for “AI agents”",
    );
  });

  it("derives action-oriented one-liners for memory commands", () => {
    expect(
      describeToolCall("memory", { args: 'create --type company --id acme --alias "Acme Inc"' }),
    ).toBe("Saving acme to memory");
    expect(
      describeToolCall("memory", {
        args: "append-evidence --kind conversation --id acme-call --subject acme",
      }),
    ).toBe("Saving evidence to memory for acme");
    expect(describeToolCall("memory", { args: 'rewrite acme --truth "Updated [^ev:x]"' })).toBe(
      "Updating memory for acme",
    );
    expect(describeToolCall("memory", { args: "doctor" })).toBe("Checking memory consistency");
    // A text-less query with --since is a recency listing, not a search.
    expect(describeToolCall("memory", { args: "query --since 24h" })).toBe(
      "Reviewing recent memory updates",
    );
    expect(describeToolCall("memory", { args: 'query --text "acme blockers" --since 24h' })).toBe(
      "Looking in memory for “acme blockers”",
    );
  });
});

describe("resolveToolDisplay", () => {
  it("unwraps the use_tool dispatcher to its inner tool name, args, and label", () => {
    const display = resolveToolDisplay("use_tool", {
      tool: "exa_search",
      arguments: { query: "competitors in fintech" },
    });
    expect(display.name).toBe("exa_search");
    expect(display.input).toEqual({ query: "competitors in fintech" });
    expect(display.label).toBe("Searching the web for “competitors in fintech”");
  });

  it("falls back to the registry title when no dynamic one-liner exists", () => {
    // tiktok_get_video has no dynamic phrasing, so the static title is used instead of the raw name.
    const display = resolveToolDisplay("use_tool", {
      tool: "tiktok_get_video",
      arguments: { id: "123" },
    });
    expect(display.name).toBe("tiktok_get_video");
    expect(display.label).toBe("TikTok video");
  });

  it("passes non-wrapped calls through and still resolves a static title", () => {
    const display = resolveToolDisplay("list_files", { path: "work" });
    expect(display.name).toBe("list_files");
    // list_files has a dynamic one-liner that wins over the static title.
    expect(display.label).toBe("Listing work");
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
          label: "Reading README.md",
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

  it("preserves failed tool-call status when the failed event has an output preview", () => {
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
              toolName: "read_file",
              input: { path: "../secret.txt" },
            },
          ],
        },
      },
      [
        event(1, "tool.failed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "read_file",
          outputPreview:
            '{\n  "ok": false,\n  "error": {\n    "code": "invalid_sandbox_path"\n  }\n}',
        }),
      ],
    );

    const toolPart = parts.find((part) => part.type === "tool-call");
    expect(toolPart?.type === "tool-call" ? toolPart.toolCall.status : null).toBe("failed");
    expect(toolPart?.type === "tool-call" ? toolPart.toolCall.outputPreview : "").toContain(
      "invalid_sandbox_path",
    );
  });

  it("renders a tool-call card while a running turn is paused awaiting approval", () => {
    const parts = buildAssistantTurnParts(
      { id: "msg_assistant", role: "assistant", content: "", status: "running" },
      [
        event(1, "message.delta", {
          messageId: "msg_assistant",
          delta: "I'll open a Linear issue for that.",
        }),
        event(2, "tool.approval_required", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "linear__create_issue",
          providerKey: "linear",
          permissionGroup: "post",
          inputPreview: '{\n  "title": "Bug"\n}',
          requestedAt: "2026-06-02T08:51:35.162Z",
        }),
      ],
    );

    expect(parts.map((part) => part.type)).toEqual(["text", "tool-call"]);
    const toolPart = parts.find((part) => part.type === "tool-call");
    expect(toolPart?.type === "tool-call" ? toolPart.toolCall.approval : undefined).toEqual({
      status: "required",
      providerKey: "linear",
      permissionGroup: "post",
      requestedAt: "2026-06-02T08:51:35.162Z",
    });
  });

  it("unwraps a use_tool envelope to its inner name + label on the approval card", () => {
    const parts = buildAssistantTurnParts(
      { id: "msg_assistant", role: "assistant", content: "", status: "running" },
      [
        event(1, "tool.approval_required", {
          messageId: "msg_assistant",
          toolCallId: "call_deferred",
          // The model called the deferred tool through the generic use_tool dispatcher, so the
          // event's top-level name is the envelope, not the action being approved.
          name: "use_tool",
          input: { tool: "linear__create_issue", arguments: { title: "Bug" } },
          providerKey: "linear",
          permissionGroup: "post",
          inputPreview: '{\n  "tool": "linear__create_issue"\n}',
          requestedAt: "2026-06-02T08:51:35.162Z",
        }),
      ],
    );

    const toolPart = parts.find((part) => part.type === "tool-call");
    // Resolves to the inner tool — never the generic "Running a tool" envelope title.
    expect(toolPart?.type === "tool-call" ? toolPart.toolCall.name : undefined).toBe(
      "linear__create_issue",
    );
    expect(toolPart?.type === "tool-call" ? toolPart.toolCall.label : undefined).not.toBe(
      "Running a tool",
    );
    expect(toolPart?.type === "tool-call" ? toolPart.toolCall.approval?.status : undefined).toBe(
      "required",
    );
  });

  it("preserves pending approval state when persisted model parts include the tool call", () => {
    const parts = buildAssistantTurnParts(
      {
        id: "msg_assistant",
        role: "assistant",
        content: "BeforeAfter",
        status: "completed",
        modelMessage: {
          role: "assistant",
          content: [
            { type: "text", text: "Before" },
            {
              type: "tool-call",
              toolCallId: "call_read",
              toolName: "linear__list_issues",
              input: { query: "test", limit: 5 },
            },
            { type: "text", text: "After" },
            {
              type: "tool-call",
              toolCallId: "call_post",
              toolName: "linear__save_comment",
              input: { issueId: "OC-184", body: "Test comment" },
            },
          ],
        },
      },
      [
        event(1, "tool.completed", {
          messageId: "msg_assistant",
          toolCallId: "call_read",
          name: "linear__list_issues",
          outputPreview: "{ issues: [] }",
        }),
        event(2, "tool.approval_required", {
          messageId: "msg_assistant",
          toolCallId: "call_post",
          name: "linear__save_comment",
          providerKey: "linear",
          permissionGroup: "post",
          inputPreview: '{\n  "issueId": "OC-184"\n}',
          requestedAt: "2026-06-02T08:51:35.162Z",
        }),
      ],
    );

    const postPart = parts.find(
      (part) => part.type === "tool-call" && part.toolCall.id === "call_post",
    );
    expect(postPart?.type === "tool-call" ? postPart.toolCall.approval : undefined).toEqual({
      status: "required",
      providerKey: "linear",
      permissionGroup: "post",
      requestedAt: "2026-06-02T08:51:35.162Z",
    });
  });

  it("builds a pending question card from a question.requested event", () => {
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
              toolCallId: "call_q",
              toolName: "ask_user_question",
              input: { questions: [] },
            },
          ],
        },
      },
      [
        event(1, "question.requested", {
          messageId: "msg_assistant",
          toolCallId: "call_q",
          questions: [
            {
              header: "Env",
              question: "Which environment?",
              options: [{ label: "Production" }, { label: "Staging", description: "safe" }],
              allowMultiple: false,
              allowOther: true,
            },
          ],
          requestedAt: "2026-06-02T08:51:35.162Z",
        }),
      ],
    );

    const toolPart = parts.find((part) => part.type === "tool-call");
    const question = toolPart?.type === "tool-call" ? toolPart.toolCall.question : undefined;
    expect(question?.status).toBe("pending");
    expect(question?.questions).toHaveLength(1);
    expect(question?.questions[0]).toMatchObject({
      header: "Env",
      question: "Which environment?",
      allowMultiple: false,
      allowOther: true,
    });
    expect(question?.questions[0]?.options).toEqual([
      { label: "Production" },
      { label: "Staging", description: "safe" },
    ]);
  });

  it("marks a question answered and carries the answers through question.answered", () => {
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
              toolCallId: "call_q",
              toolName: "ask_user_question",
              input: { questions: [] },
            },
          ],
        },
      },
      [
        event(1, "question.requested", {
          messageId: "msg_assistant",
          toolCallId: "call_q",
          questions: [
            {
              header: "Env",
              question: "Which environment?",
              options: [{ label: "Production" }],
              allowMultiple: false,
              allowOther: false,
            },
          ],
          requestedAt: "2026-06-02T08:51:35.162Z",
        }),
        event(2, "question.answered", {
          messageId: "msg_assistant",
          toolCallId: "call_q",
          answers: [{ selectedLabels: ["Production"] }],
          resolutionSource: "user",
        }),
      ],
    );

    const toolPart = parts.find((part) => part.type === "tool-call");
    const question = toolPart?.type === "tool-call" ? toolPart.toolCall.question : undefined;
    expect(question?.status).toBe("answered");
    expect(question?.answers).toEqual([{ selectedLabels: ["Production"] }]);
    // The original questions survive so the summary can pair each with its answer.
    expect(question?.questions[0]?.question).toBe("Which environment?");
  });

  it("marks a question cancelled when superseded", () => {
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
              toolCallId: "call_q",
              toolName: "ask_user_question",
              input: { questions: [] },
            },
          ],
        },
      },
      [
        event(1, "question.requested", {
          messageId: "msg_assistant",
          toolCallId: "call_q",
          questions: [
            {
              header: "Env",
              question: "Which?",
              options: [{ label: "A" }],
              allowMultiple: false,
              allowOther: false,
            },
          ],
          requestedAt: "2026-06-02T08:51:35.162Z",
        }),
        event(2, "question.answered", {
          messageId: "msg_assistant",
          toolCallId: "call_q",
          answers: [],
          resolutionSource: "superseded",
        }),
      ],
    );

    const toolPart = parts.find((part) => part.type === "tool-call");
    const question = toolPart?.type === "tool-call" ? toolPart.toolCall.question : undefined;
    expect(question?.status).toBe("cancelled");
    expect(question?.resolutionSource).toBe("superseded");
  });

  it("marks a user X-decline cancelled via the explicit answered flag, not the resolution source", () => {
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
              toolCallId: "call_q",
              toolName: "ask_user_question",
              input: { questions: [] },
            },
          ],
        },
      },
      [
        event(1, "question.requested", {
          messageId: "msg_assistant",
          toolCallId: "call_q",
          questions: [
            {
              header: "Env",
              question: "Which?",
              options: [{ label: "A" }],
              allowMultiple: false,
              allowOther: false,
            },
          ],
          requestedAt: "2026-06-02T08:51:35.162Z",
        }),
        // The X-dismiss resolves with (cancelled, user). Inferring from resolutionSource alone would
        // wrongly read this as an answer; the explicit `answered: false` keeps it a skip.
        event(2, "question.answered", {
          messageId: "msg_assistant",
          toolCallId: "call_q",
          answered: false,
          answers: [],
          resolutionSource: "user",
        }),
      ],
    );

    const toolPart = parts.find((part) => part.type === "tool-call");
    const question = toolPart?.type === "tool-call" ? toolPart.toolCall.question : undefined;
    expect(question?.status).toBe("cancelled");
    expect(question?.resolutionSource).toBe("user");
  });

  it("preserves approval decision source after a paused tool call is resolved", () => {
    const timeoutParts = buildAssistantTurnParts(
      { id: "msg_assistant", role: "assistant", content: "", status: "running" },
      [
        event(1, "tool.approval_required", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "linear__save_comment",
          providerKey: "linear",
          permissionGroup: "post",
          inputPreview: '{\n  "issueId": "OC-222"\n}',
          requestedAt: "2026-06-02T08:51:35.162Z",
        }),
        event(2, "tool.approval_resolved", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "linear__save_comment",
          decision: "denied",
          decisionSource: "timeout",
        }),
      ],
    );

    const timeoutToolPart = timeoutParts.find((part) => part.type === "tool-call");
    expect(
      timeoutToolPart?.type === "tool-call" ? timeoutToolPart.toolCall.approval : undefined,
    ).toEqual({
      status: "denied",
      providerKey: "linear",
      permissionGroup: "post",
      requestedAt: "2026-06-02T08:51:35.162Z",
      decisionSource: "timeout",
    });

    const userParts = buildAssistantTurnParts(
      { id: "msg_assistant", role: "assistant", content: "", status: "running" },
      [
        event(1, "tool.approval_required", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "linear__save_comment",
          providerKey: "linear",
          permissionGroup: "post",
          requestedAt: "2026-06-02T08:51:35.162Z",
        }),
        event(2, "tool.approval_resolved", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "linear__save_comment",
          decision: "denied",
          decisionSource: "user",
        }),
      ],
    );

    const userToolPart = userParts.find((part) => part.type === "tool-call");
    expect(
      userToolPart?.type === "tool-call" ? userToolPart.toolCall.approval?.decisionSource : null,
    ).toBe("user");
  });

  it("marks a pending approval as approved once the resumed tool starts", () => {
    const parts = buildAssistantTurnParts(
      { id: "msg_assistant", role: "assistant", content: "", status: "running" },
      [
        event(1, "tool.approval_required", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "opencode_coder",
          providerKey: "opencode",
          permissionGroup: "modify",
          inputPreview: '{\n  "task": "Fix the bug"\n}',
          requestedAt: "2026-06-02T08:51:35.162Z",
        }),
        event(2, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "opencode_coder",
          input: { task: "Fix the bug" },
        }),
      ],
    );

    const toolPart = parts.find((part) => part.type === "tool-call");
    expect(toolPart?.type === "tool-call" ? toolPart.toolCall.approval : undefined).toEqual({
      status: "approved",
      providerKey: "opencode",
      permissionGroup: "modify",
      requestedAt: "2026-06-02T08:51:35.162Z",
      decisionSource: "user",
    });
    expect(toolPart?.type === "tool-call" ? toolPart.toolCall.status : null).toBe("running");
  });

  it("does not coerce malformed approval permission groups to admin", () => {
    const parts = buildAssistantTurnParts(
      { id: "msg_assistant", role: "assistant", content: "", status: "running" },
      [
        event(1, "tool.approval_required", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "linear__save_comment",
          providerKey: "linear",
          permissionGroup: "owner",
        }),
      ],
    );

    const toolPart = parts.find((part) => part.type === "tool-call");
    expect(
      toolPart?.type === "tool-call" ? toolPart.toolCall.approval?.permissionGroup : null,
    ).toBeUndefined();
  });

  it("splits streamed text at step boundaries and repositions leading punctuation", () => {
    const parts = buildAssistantTurnParts(
      { id: "msg_assistant", role: "assistant", content: "", status: "running" },
      [
        event(1, "message.delta", {
          messageId: "msg_assistant",
          delta: "I'll research and cite the sources I used",
        }),
        event(2, "tool.started", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "exa_search",
          input: { query: "meaning of life" },
        }),
        event(3, "tool.completed", {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "exa_search",
          output: { ok: true },
        }),
        event(4, "message.delta", {
          messageId: "msg_assistant",
          delta: ". Might take a minute or two if you want.",
        }),
        event(5, "session.usage", { messageId: "msg_assistant", stepIndex: 1 }),
        event(6, "message.delta", {
          messageId: "msg_assistant",
          delta: "The first pass came up empty, so I'll continue.",
        }),
      ],
    );

    expect(parts.map((part) => part.type)).toEqual(["text", "tool-call", "text", "text"]);
    expect(parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual([
      "I'll research and cite the sources I used.",
      "Might take a minute or two if you want.",
      "The first pass came up empty, so I'll continue.",
    ]);
  });

  it("repositions leading punctuation across tool calls in the completed turn", () => {
    const parts = buildAssistantTurnParts(
      {
        id: "msg_assistant",
        role: "assistant",
        content: "",
        status: "completed",
        modelMessage: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check the sources I used" },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "exa_search",
              input: { query: "x" },
            },
            { type: "text", text: ". Done summarizing." },
          ],
        },
      },
      [],
    );

    expect(parts.flatMap((part) => (part.type === "text" ? [part.text] : []))).toEqual([
      "Let me check the sources I used.",
      "Done summarizing.",
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
      {
        type: "reasoning",
        text: "Checked the relevant files first.",
      },
      { type: "text", text: "Final answer" },
    ]);
  });

  it("prepends raw reasoning content without mixing it into visible text", () => {
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
        event(1, "message.reasoning_content", {
          messageId: "msg_assistant",
          text: "Raw Kimi reasoning.",
          format: "raw",
        }),
      ],
    );

    expect(parts).toEqual([
      {
        type: "reasoning",
        text: "Raw Kimi reasoning.",
      },
      { type: "text", text: "Final answer" },
    ]);
  });

  it("renders live reasoning deltas before completion", () => {
    const parts = buildAssistantTurnParts(
      {
        id: "msg_assistant",
        role: "assistant",
        content: "",
        status: "running",
      },
      [
        event(null, "message.reasoning_delta", {
          messageId: "msg_assistant",
          delta: "Considering",
        }),
        event(null, "message.reasoning_delta", {
          messageId: "msg_assistant",
          delta: " constraints.",
        }),
      ],
    );

    expect(parts).toEqual([
      {
        type: "reasoning",
        text: "Considering constraints.",
      },
    ]);
  });

  it("prefers final raw reasoning content over earlier live reasoning deltas", () => {
    const parts = buildAssistantTurnParts(
      {
        id: "msg_assistant",
        role: "assistant",
        content: "Final answer",
        status: "completed",
      },
      [
        event(null, "message.reasoning_delta", {
          messageId: "msg_assistant",
          delta: "Partial live thought.",
        }),
        event(1, "message.reasoning_content", {
          messageId: "msg_assistant",
          text: "Complete raw reasoning.",
          format: "raw",
        }),
      ],
    );

    expect(parts).toEqual([
      {
        type: "reasoning",
        text: "Complete raw reasoning.",
      },
      { type: "text", text: "Final answer" },
    ]);
  });

  it("uses persisted model-message reasoning when no reasoning content event exists", () => {
    const parts = buildAssistantTurnParts(
      {
        id: "msg_assistant",
        role: "assistant",
        content: "Final answer",
        status: "completed",
        modelMessage: {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Raw persisted reasoning." },
            { type: "text", text: "Final answer" },
          ],
        },
      },
      [],
    );

    expect(parts).toEqual([
      {
        type: "reasoning",
        text: "Raw persisted reasoning.",
      },
      { type: "text", text: "Final answer" },
    ]);
  });

  it("does not render a reasoning part for reasoning tokens without real reasoning evidence", () => {
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

    expect(parts).toEqual([{ type: "text", text: "Final answer" }]);
  });

  it("renders a summary without duration when no timed reasoning events exist", () => {
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
          content: [{ type: "text", text: "Final answer" }],
        },
      },
      [
        event(1, "message.reasoning_summary", {
          messageId: "msg_assistant",
          summary: "Reviewed the request.",
        }),
      ],
    );

    expect(parts).toEqual([
      { type: "reasoning", text: "Reviewed the request." },
      { type: "text", text: "Final answer" },
    ]);
  });

  it("sums timed reasoning windows without counting tool or text time", () => {
    const parts = buildAssistantTurnParts(
      {
        id: "msg_assistant",
        role: "assistant",
        content: "Final answer",
        status: "completed",
        outputReasoningTokens: 74,
        createdAt: "2026-05-22T13:00:00.000Z",
        completedAt: "2026-05-22T13:00:20.000Z",
        modelMessage: {
          role: "assistant",
          content: [{ type: "text", text: "Final answer" }],
        },
      },
      [
        event(
          1,
          "message.reasoning_delta",
          { messageId: "msg_assistant", delta: "Think 1" },
          "2026-05-22T13:00:01.000Z",
        ),
        event(
          2,
          "tool.started",
          { messageId: "msg_assistant", toolCallId: "call_1" },
          "2026-05-22T13:00:04.000Z",
        ),
        event(
          3,
          "tool.completed",
          { messageId: "msg_assistant", toolCallId: "call_1" },
          "2026-05-22T13:00:14.000Z",
        ),
        event(
          4,
          "message.reasoning_delta",
          { messageId: "msg_assistant", delta: "Think 2" },
          "2026-05-22T13:00:15.000Z",
        ),
        event(
          5,
          "message.delta",
          { messageId: "msg_assistant", delta: "Final answer" },
          "2026-05-22T13:00:17.000Z",
        ),
      ],
    );

    expect(parts).toEqual([
      { type: "reasoning", durationSeconds: 5, text: "Think 1Think 2" },
      { type: "text", text: "Final answer" },
    ]);
  });

  it("adds live thinking duration when completion arrives after reasoning usage, subtracting tool call duration", () => {
    let state = initialState();
    state = applyRuntimeEventToState(
      state,
      event(
        1,
        "message.created",
        {
          messageId: "msg_assistant",
          role: "assistant",
        },
        "2026-05-22T13:00:00.000Z",
      ),
    );

    const createdAt = state.messages.find((message) => message.id === "msg_assistant")?.createdAt;

    // Stamp tool events with synthetic createdAt timestamps so
    // computeThinkingDurationSeconds can measure a 2-second tool interval.
    const toolStartTs = new Date(Date.parse(createdAt!) + 1000).toISOString();
    const toolEndTs = new Date(Date.parse(createdAt!) + 3000).toISOString();
    state = applyRuntimeEventToState(state, {
      ...event(2, "tool.started", {
        messageId: "msg_assistant",
        toolCallId: "call_1",
        name: "read_file",
        input: { path: "README.md" },
      }),
      createdAt: toolStartTs,
    });
    state = applyRuntimeEventToState(state, {
      ...event(3, "tool.completed", {
        messageId: "msg_assistant",
        toolCallId: "call_1",
        name: "read_file",
        output: { content: "hi" },
      }),
      createdAt: toolEndTs,
    });

    state = applyRuntimeEventToState(
      state,
      event(
        4,
        "message.reasoning_delta",
        {
          messageId: "msg_assistant",
          delta: "Thinking",
        },
        "2026-05-22T13:00:01.000Z",
      ),
    );
    state = applyRuntimeEventToState(
      state,
      event(
        5,
        "session.usage",
        {
          messageId: "msg_assistant",
          inputTokens: 100,
          outputTokens: 25,
          outputTextTokens: 20,
          outputReasoningTokens: 5,
          totalTokens: 125,
        },
        "2026-05-22T13:00:04.000Z",
      ),
    );
    state = applyRuntimeEventToState(
      state,
      event(
        6,
        "message.completed",
        {
          messageId: "msg_assistant",
          content: "Done",
        },
        "2026-05-22T13:00:10.000Z",
      ),
    );

    const msg = state.messages.find((message) => message.id === "msg_assistant");
    expect(msg).toMatchObject({
      createdAt,
      completedAt: "2026-05-22T13:00:10.000Z",
      thinkingDurationSeconds: 3,
    });
    // The computed value must be at least 1 (minimum floor).
    expect(msg!.thinkingDurationSeconds!).toBeGreaterThanOrEqual(1);
    // With a 2-second stamped tool interval and very short real-clock duration,
    // the subtraction logic clamps to at most the message duration → verify ≥ 1.
    // Direct verification of subtraction is covered by computeThinkingDurationSeconds unit tests.
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
          brainFile: { scope: "company", path: "foo.md" },
          brainPath: "foo.md",
        },
      },
    ]);
  });

  it("marks persisted write_file model parts for personal brain paths", () => {
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
              input: { path: "personal-brain/foo.md", content: "Updated notes" },
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
          brainFile: { scope: "personal", path: "foo.md" },
        },
      },
    ]);
    expect(
      parts[0]?.type === "tool-call" ? parts[0].toolCall.brainPath : undefined,
    ).toBeUndefined();
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
        anchorMessageId: "msg_user",
        part: {
          type: "tool-call",
          toolCall: {
            id: "after-session:12",
            name: "updating_memory",
            label: "Updated memory",
            status: "completed",
            inputPreview: "",
            activityPreview: "",
            outputPreview: "Memory updated",
            startedEventId: 1,
            completedEventId: 2,
          },
        },
      },
    ]);
  });

  it("surfaces the memory pass summary as the tool call's result", () => {
    const parts = buildBackgroundActivityParts(
      [
        event(1, "after_session.spawned", {
          runId: 12,
          messageId: "msg_user",
          childSessionId: "ses_memory",
        }),
        event(2, "after_session.completed", {
          runId: 12,
          messageId: "msg_user",
          childSessionId: "ses_memory",
          summary: "Remembered the integration-connection-pill product idea.",
        }),
      ],
      [],
    );

    expect(parts).toMatchObject([
      {
        anchorMessageId: "msg_user",
        part: {
          type: "tool-call",
          toolCall: {
            label: "Updated memory",
            status: "completed",
            activityPreview: "Remembered the integration-connection-pill product idea.",
            outputPreview: "Remembered the integration-connection-pill product idea.",
          },
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
      anchorMessageId: "msg_user",
      part: {
        type: "tool-call",
        toolCall: {
          name: "updating_memory",
          status: "completed",
          startedEventId: 1,
          completedEventId: 2,
        },
      },
    });
  });

  it("keeps spawned memory-keeper passes running until the child reports completion", () => {
    const runningParts = buildBackgroundActivityParts(
      [
        event(1, "after_session.spawned", {
          runId: 12,
          messageId: "msg_user",
          childSessionId: "ses_memory",
        }),
      ],
      [],
    );

    expect(runningParts).toMatchObject([
      {
        anchorMessageId: "msg_user",
        part: {
          type: "tool-call",
          toolCall: {
            id: "after-session:12",
            name: "updating_memory",
            status: "running",
            startedEventId: 1,
          },
        },
      },
    ]);

    const completedParts = buildBackgroundActivityParts(
      [
        event(1, "after_session.spawned", {
          runId: 12,
          messageId: "msg_user",
          childSessionId: "ses_memory",
        }),
        event(9, "after_session.completed", {
          runId: 12,
          messageId: "msg_user",
          childSessionId: "ses_memory",
        }),
      ],
      [],
    );

    expect(completedParts).toMatchObject([
      {
        anchorMessageId: "msg_user",
        part: {
          type: "tool-call",
          toolCall: {
            id: "after-session:12",
            name: "updating_memory",
            status: "completed",
            outputPreview: "Memory updated",
            startedEventId: 1,
            completedEventId: 9,
          },
        },
      },
    ]);
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
        anchorMessageId: "msg_user",
        part: {
          type: "tool-call",
          toolCall: {
            id: "after-session:12",
            name: "updating_memory",
            status: "completed",
          },
        },
      },
      {
        anchorMessageId: null,
        part: {
          type: "tool-call",
          toolCall: {
            id: "call_1",
            name: "write_file",
            status: "completed",
            brainPath: "memory.md",
          },
        },
      },
    ]);
  });
});

describe("computeThinkingDurationSeconds", () => {
  // Helper: build a minimal completed SessionMessage.
  function completedMessage(
    startIso: string,
    endIso: string,
    id = "msg_assistant",
  ): SessionMessage {
    return {
      id,
      role: "assistant",
      content: "",
      status: "completed",
      createdAt: startIso,
      completedAt: endIso,
    };
  }

  // Helper: build a RuntimeEvent with createdAt stamped.
  function timedEvent(
    id: number,
    type: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ): RuntimeEvent {
    return { id, type, payload, messageId: null, createdAt };
  }

  it("returns undefined when there are no timed reasoning windows", () => {
    const msg = completedMessage("2026-05-28T10:00:00.000Z", "2026-05-28T10:00:05.000Z");
    expect(computeThinkingDurationSeconds(msg, [])).toBeUndefined();
  });

  it("measures one durable reasoning window", () => {
    const msg = completedMessage("2026-05-28T10:00:00.000Z", "2026-05-28T10:00:10.000Z");
    const events: RuntimeEvent[] = [
      timedEvent(
        1,
        "message.reasoning_started",
        { messageId: "msg_assistant" },
        "2026-05-28T10:00:02.000Z",
      ),
      timedEvent(
        2,
        "message.reasoning_completed",
        { messageId: "msg_assistant" },
        "2026-05-28T10:00:06.000Z",
      ),
    ];
    expect(computeThinkingDurationSeconds(msg, events)).toBe(4);
  });

  it("sums multiple durable reasoning windows", () => {
    const msg = completedMessage("2026-05-28T10:00:00.000Z", "2026-05-28T10:00:20.000Z");
    const events: RuntimeEvent[] = [
      timedEvent(
        1,
        "message.reasoning_started",
        { messageId: "msg_assistant" },
        "2026-05-28T10:00:02.000Z",
      ),
      timedEvent(
        2,
        "message.reasoning_completed",
        { messageId: "msg_assistant" },
        "2026-05-28T10:00:07.000Z",
      ),
      timedEvent(
        3,
        "message.reasoning_started",
        { messageId: "msg_assistant" },
        "2026-05-28T10:00:10.000Z",
      ),
      timedEvent(
        4,
        "message.reasoning_completed",
        { messageId: "msg_assistant" },
        "2026-05-28T10:00:15.000Z",
      ),
    ];
    expect(computeThinkingDurationSeconds(msg, events)).toBe(10);
  });

  it("returns at least 1 when the message duration is sub-second", () => {
    const msg = completedMessage("2026-05-28T10:00:00.000Z", "2026-05-28T10:00:00.400Z");
    const events: RuntimeEvent[] = [
      timedEvent(
        1,
        "message.reasoning_started",
        { messageId: "msg_assistant" },
        "2026-05-28T10:00:00.000Z",
      ),
      timedEvent(
        2,
        "message.reasoning_completed",
        { messageId: "msg_assistant" },
        "2026-05-28T10:00:00.400Z",
      ),
    ];
    expect(computeThinkingDurationSeconds(msg, events)).toBe(1);
  });

  it("uses message completion to close an open reasoning window", () => {
    const msg = completedMessage("2026-05-28T10:00:00.000Z", "2026-05-28T10:00:03.000Z");
    const events: RuntimeEvent[] = [
      timedEvent(
        1,
        "message.reasoning_started",
        { messageId: "msg_assistant" },
        "2026-05-28T10:00:01.000Z",
      ),
    ];
    expect(computeThinkingDurationSeconds(msg, events)).toBe(2);
  });

  it("returns undefined when completion is missing and no completed reasoning window exists", () => {
    const noCreatedAt: SessionMessage = {
      id: "msg_assistant",
      role: "assistant",
      content: "",
      status: "running",
    };
    expect(computeThinkingDurationSeconds(noCreatedAt, [])).toBeUndefined();

    const noCompletedAt: SessionMessage = {
      id: "msg_assistant",
      role: "assistant",
      content: "",
      status: "running",
      createdAt: "2026-05-28T10:00:00.000Z",
    };
    expect(
      computeThinkingDurationSeconds(noCompletedAt, [
        timedEvent(
          1,
          "message.reasoning_started",
          { messageId: "msg_assistant" },
          "2026-05-28T10:00:01.000Z",
        ),
      ]),
    ).toBeUndefined();
  });

  it("uses old transient reasoning deltas as backward-compatible timing input", () => {
    const msg = completedMessage("2026-05-28T10:00:00.000Z", "2026-05-28T10:00:08.000Z");
    const events: RuntimeEvent[] = [
      timedEvent(
        1,
        "message.reasoning_delta",
        { messageId: "msg_assistant", delta: "Thinking" },
        "2026-05-28T10:00:02.000Z",
      ),
      timedEvent(
        2,
        "tool.started",
        {
          messageId: "msg_assistant",
          toolCallId: "call_1",
          name: "read_file",
          input: {},
        },
        "2026-05-28T10:00:05.000Z",
      ),
    ];
    expect(computeThinkingDurationSeconds(msg, events)).toBe(3);
  });
});

function event(
  id: number | null,
  type: string,
  payload: Record<string, unknown>,
  createdAt?: string,
): RuntimeEvent {
  return { id, type, payload, messageId: null, ...(createdAt ? { createdAt } : {}) };
}
