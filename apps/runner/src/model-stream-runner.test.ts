import { modelMessageSchema, type TextStreamPart, type ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLeaseDb, usage } from "./agent-loop-test-support";
import { appendRuntimeEvent, publishTransientRuntimeEvent } from "./events";
import { buildAssistantModelMessage } from "./model-messages";
import { collectAssistantStream } from "./model-stream-runner";
import {
  assertTurnComplete,
  detectIncompleteTurn,
  isToolStepLimitExceeded,
  MAX_MODEL_STEPS,
  SOFT_FINALIZATION_STEP,
  softFinalizationStepSettings,
} from "./model-turn";
import {
  createRunControlGate,
  RunAbortError,
  type RunControlStore,
  type RunLeaseState,
} from "./run-control";
import { RunSpendCapError, RunSuspendedError, ToolStepLimitExceededError } from "./runner-errors";
import { throwIfStreamErrorPart } from "./stream-helpers";
import { createToolStartCoordinator } from "./tool-start-coordinator";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));
const usageRecorder = vi.hoisted(() => ({
  recordStepUsage: vi.fn(async () => {}),
}));
const eventMocks = vi.hoisted(() => ({
  appendRuntimeEvent: vi.fn(async (_db: unknown, _event: unknown) => ({ id: 1 })),
  publishTransientRuntimeEvent: vi.fn((event: unknown) => event),
}));
const leaseWrites = vi.hoisted(() => ({
  appendRuntimeEventForLease: vi.fn(async (event: unknown) => {
    await eventMocks.appendRuntimeEvent(undefined, event);
    return true;
  }),
  insertToolMessageForLease: vi.fn(async () => true),
  insertToolApprovalForLease: vi.fn(async () => "inserted"),
  requireLeaseWrite: vi.fn(async (value: unknown) => value),
}));

vi.mock("./db", () => ({ getDb: dbMocks.getDb }));
vi.mock("./usage-recorder", () => usageRecorder);
vi.mock("./events", () => eventMocks);
vi.mock("./lease-writes", () => leaseWrites);

afterEach(() => {
  vi.clearAllMocks();
});

describe("collectAssistantStream", () => {
  it("does not close the iterator after natural completion", async () => {
    const stream = createStream([
      streamPart({ type: "text-delta", text: "Hello" }),
      streamPart({ type: "text-delta", text: " world" }),
    ]);

    await expect(collect(stream)).resolves.toMatchObject({
      assistantContent: "Hello world",
      assistantReplayParts: [{ type: "text", text: "Hello world" }],
    });
    expect(stream.return).not.toHaveBeenCalled();
  });

  it("releases a denied tool call with a deny verdict and never starts the body unguarded", async () => {
    const coordinator = createToolStartCoordinator();
    const markStarted = vi.spyOn(coordinator, "markStarted");
    const stream = createStream([
      streamPart({
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "slack__chat_postMessage",
        input: { text: "hi" },
      }),
    ]);

    await collect(stream, {
      toolStartCoordinator: coordinator,
      policy: new Map([["slack:post", "deny"]]),
    });

    expect(markStarted).toHaveBeenCalledWith(
      "call_1",
      expect.objectContaining({ decision: "deny", providerKey: "slack", group: "post" }),
    );
  });

  it("releases an allowed tool call with an allow verdict", async () => {
    const coordinator = createToolStartCoordinator();
    const markStarted = vi.spyOn(coordinator, "markStarted");
    const stream = createStream([
      streamPart({
        type: "tool-call",
        toolCallId: "call_read",
        toolName: "slack__search",
        input: { query: "launch" },
      }),
    ]);

    await collect(stream, { toolStartCoordinator: coordinator });

    expect(markStarted).toHaveBeenCalledWith(
      "call_read",
      expect.objectContaining({ decision: "allow", providerKey: "slack", group: "read" }),
    );
  });

  it("collapses an ask decision to deny in a non-suspendable run", async () => {
    const coordinator = createToolStartCoordinator();
    const markStarted = vi.spyOn(coordinator, "markStarted");
    const stream = createStream([
      streamPart({
        type: "tool-call",
        toolCallId: "call_ask",
        toolName: "slack__chat_postMessage",
        input: { text: "hi" },
      }),
    ]);

    await collect(stream, { toolStartCoordinator: coordinator, suspendable: false });

    expect(markStarted).toHaveBeenCalledWith(
      "call_ask",
      expect.objectContaining({ decision: "deny", providerKey: "slack", group: "post" }),
    );
  });

  it("suspends the run at an ask gate in a suspendable run", async () => {
    const coordinator = createToolStartCoordinator();
    const suspend = vi.spyOn(coordinator, "suspend");
    const stream = createStream([
      streamPart({ type: "text-delta", text: "I'll post that." }),
      streamPart({
        type: "tool-call",
        toolCallId: "call_ask",
        toolName: "slack__chat_postMessage",
        input: { text: "hi" },
      }),
    ]);

    const error = await collect(stream, {
      toolStartCoordinator: coordinator,
      suspendable: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RunSuspendedError);
    const suspended = error as RunSuspendedError;
    expect(suspended.toolCallId).toBe("call_ask");
    expect(suspended.providerKey).toBe("slack");
    expect(suspended.group).toBe("post");
    // The partial assistant turn ends in the pending tool-call so resume can pair it.
    expect(suspended.assistantReplayParts.at(-1)).toEqual({
      type: "tool-call",
      toolCallId: "call_ask",
      toolName: "slack__chat_postMessage",
      input: { text: "hi" },
    });
    // The approval row + event are persisted, and parked siblings are released. The event
    // carries the structured input so the approval card can unwrap a use_tool envelope.
    expect(leaseWrites.appendRuntimeEventForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool.approval_required",
        payload: expect.objectContaining({ input: { text: "hi" } }),
      }),
    );
    expect(suspend).toHaveBeenCalledTimes(1);
    // The stream is torn down on the way out.
    expect(stream.return).toHaveBeenCalledTimes(1);
  });

  it("closes the iterator when run control fails after a streamed part", async () => {
    const stream = createStream([
      streamPart({ type: "text-delta", text: "partial" }),
      streamPart({ type: "text-delta", text: " ignored" }),
    ]);
    const checkAbort = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("lease lost"));

    await expect(collect(stream, { checkAbort })).rejects.toThrow("lease lost");
    expect(stream.return).toHaveBeenCalledTimes(1);
  });

  it("closes the iterator on stream errors without masking the original error", async () => {
    const stream = createStream(
      [streamPart({ type: "text-delta", text: "partial" }), new Error("stream failed")],
      { returnError: new Error("cleanup failed") },
    );

    await expect(collect(stream)).rejects.toThrow("stream failed");
    expect(stream.return).toHaveBeenCalledTimes(1);
  });

  it("records finish-step usage on successful completion", async () => {
    const response = {
      id: "resp_123",
      modelId: "openai/gpt-5.4-mini",
      timestamp: new Date("2026-05-29T08:00:00.000Z"),
    };
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    };
    const stream = createStream([
      streamPart({
        type: "finish-step",
        finishReason: "stop",
        rawFinishReason: "stop",
        response,
        usage,
      }),
    ]);

    await expect(collect(stream)).resolves.toMatchObject({ assistantContent: "" });
    expect(usageRecorder.recordStepUsage).toHaveBeenCalledWith({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      stepIndex: 1,
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      response,
      usage,
      finishReason: "stop",
      rawFinishReason: "stop",
    });
    expect(stream.return).not.toHaveBeenCalled();
  });

  it("publishes text deltas as transient runtime events as they arrive", async () => {
    const stream = createStream([
      streamPart({ type: "text-delta", text: "Hello" }),
      streamPart({ type: "text-delta", text: " world" }),
    ]);

    await collect(stream);

    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenNthCalledWith(1, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.delta",
      payload: { messageId: "msg_assistant", delta: "Hello" },
    });
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenNthCalledWith(2, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.delta",
      payload: { messageId: "msg_assistant", delta: " world" },
    });
  });

  it("publishes reasoning deltas as transient runtime events as they arrive", async () => {
    const stream = createStream([
      streamPart({ type: "reasoning-delta", text: "Thinking" }),
      streamPart({ type: "reasoning-delta", delta: "..." }),
      streamPart({ type: "reasoning", text: " done" }),
    ]);

    await collect(stream, { reasoningExposure: "summary" });

    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenNthCalledWith(1, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.reasoning_delta",
      payload: { messageId: "msg_assistant", delta: "Thinking" },
    });
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenNthCalledWith(2, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.reasoning_delta",
      payload: { messageId: "msg_assistant", delta: "..." },
    });
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenNthCalledWith(3, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.reasoning_delta",
      payload: { messageId: "msg_assistant", delta: " done" },
    });
    expect(leaseWrites.appendRuntimeEventForLease).toHaveBeenNthCalledWith(1, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      leaseId: "run_123",
      leaseOwner: "runner-test",
      type: "message.reasoning_started",
      payload: { messageId: "msg_assistant" },
    });
    expect(leaseWrites.appendRuntimeEventForLease).toHaveBeenNthCalledWith(2, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      leaseId: "run_123",
      leaseOwner: "runner-test",
      type: "message.reasoning_completed",
      payload: { messageId: "msg_assistant" },
    });
  });

  it("does not read run control from the DB on every streamed part", async () => {
    // Many fast text-delta tokens emitted inside a single throttle window.
    const stream = createStream(
      Array.from({ length: 50 }, (_, i) => streamPart({ type: "text-delta", text: `t${i}` })),
    );
    const { gate, heartbeatAndLoadState } = gateHarness();

    await collect(stream, { checkAbort: gate, signal: new AbortController().signal });

    // O(1) DB reconciliations for 50 parts, not O(N).
    expect(heartbeatAndLoadState).toHaveBeenCalledTimes(1);
  });

  it("forces a run-control read at each finish-step boundary", async () => {
    const stream = createStream([
      streamPart({ type: "text-delta", text: "answer" }),
      streamPart({ type: "finish-step", finishReason: "stop", rawFinishReason: "stop" }),
    ]);
    const { gate, heartbeatAndLoadState } = gateHarness();

    await collect(stream, { checkAbort: gate, signal: new AbortController().signal });

    // Initial part read (1) plus the forced finish-step boundary read (2).
    expect(heartbeatAndLoadState).toHaveBeenCalledTimes(2);
  });

  it("persists invalid tool input stream errors as recoverable tool results", async () => {
    const coordinator = createToolStartCoordinator();
    const markStarted = vi.spyOn(coordinator, "markStarted");
    const malformedInput = '{"path":"brain/report.md","content":"unterminated';
    const stream = createStream([
      streamPart({
        type: "tool-call",
        toolCallId: "call_write",
        toolName: "write_file",
        input: malformedInput,
        invalid: true,
      }),
      streamPart({
        type: "tool-error",
        toolCallId: "call_write",
        toolName: "write_file",
        input: malformedInput,
        error:
          "Invalid input for tool write_file: JSON parsing failed. Error message: JSON Parse error: Unterminated string",
      }),
      streamPart({
        type: "finish-step",
        finishReason: "tool-calls",
        rawFinishReason: "tool_use",
      }),
    ]);

    await expect(collect(stream, { toolStartCoordinator: coordinator })).resolves.toMatchObject({
      assistantReplayParts: [
        {
          type: "tool-call",
          toolCallId: "call_write",
          toolName: "write_file",
          input: malformedInput,
        },
      ],
      lastStepEndedWithToolCalls: true,
    });

    expect(markStarted).not.toHaveBeenCalled();
    expect(leaseWrites.insertToolMessageForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ses_123",
        toolName: "write_file",
        toolCallId: "call_write",
        content: expect.stringContaining('"code":"invalid_tool_input"'),
      }),
    );
    const insertCalls = vi.mocked(leaseWrites.insertToolMessageForLease).mock.calls as unknown[][];
    const insertedToolMessage = insertCalls[0]?.[0] as { content?: unknown } | undefined;
    expect(String(insertedToolMessage?.content)).not.toContain("unterminated");
    expect(leaseWrites.appendRuntimeEventForLease).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool.failed",
        payload: expect.objectContaining({
          toolCallId: "call_write",
          name: "write_file",
          error: expect.objectContaining({
            code: "invalid_tool_input",
            recoverable: true,
          }),
        }),
      }),
    );
    expect(leaseWrites.appendRuntimeEventForLease).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "tool.started" }),
    );
  });

  it("stops within one stream part when the local controller is aborted, without a DB read", async () => {
    const stream = createStream([
      streamPart({ type: "text-delta", text: "first" }),
      streamPart({ type: "text-delta", text: "second" }),
      streamPart({ type: "text-delta", text: "third" }),
    ]);
    const { gate, heartbeatAndLoadState, controller } = gateHarness();

    // Local abort fires before streaming begins (e.g. stop button already pressed).
    controller.abort();

    await expect(collect(stream, { checkAbort: gate, signal: controller.signal })).rejects.toThrow(
      RunAbortError,
    );
    expect(stream.return).toHaveBeenCalledTimes(1);
    // Instant local abort: no DB round-trip at all.
    expect(heartbeatAndLoadState).not.toHaveBeenCalled();
  });

  it("publishes and stores raw reasoning when raw exposure is enabled", async () => {
    const stream = createStream([
      streamPart({ type: "reasoning-delta", delta: "Thinking" }),
      streamPart({ type: "reasoning-delta", delta: "..." }),
      streamPart({ type: "text-delta", text: "Visible answer" }),
    ]);

    await expect(collect(stream, { reasoningExposure: "raw" })).resolves.toMatchObject({
      assistantContent: "Visible answer",
      assistantReplayParts: [
        { type: "reasoning", text: "Thinking..." },
        { type: "text", text: "Visible answer" },
      ],
      reasoningContent: "Thinking...",
      reasoningSummary: "",
    });
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenNthCalledWith(1, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.reasoning_delta",
      payload: { messageId: "msg_assistant", delta: "Thinking" },
    });
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenNthCalledWith(2, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.reasoning_delta",
      payload: { messageId: "msg_assistant", delta: "..." },
    });
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenNthCalledWith(3, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.delta",
      payload: { messageId: "msg_assistant", delta: "Visible answer" },
    });
  });

  it("converts raw Moonshot reasoning_content chunks into raw reasoning deltas", async () => {
    const stream = createStream([
      streamPart({
        type: "raw",
        rawValue: {
          choices: [{ delta: { reasoning_content: "Inspecting" } }],
        },
      }),
      streamPart({
        type: "raw",
        rawValue: {
          choices: [{ delta: { reasoning_content: " constraints." } }],
        },
      }),
      streamPart({ type: "text-delta", text: "Visible answer" }),
    ]);

    await expect(collect(stream, { reasoningExposure: "raw" })).resolves.toMatchObject({
      assistantContent: "Visible answer",
      assistantReplayParts: [
        { type: "reasoning", text: "Inspecting constraints." },
        { type: "text", text: "Visible answer" },
      ],
      reasoningContent: "Inspecting constraints.",
    });
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenNthCalledWith(1, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.reasoning_delta",
      payload: { messageId: "msg_assistant", delta: "Inspecting" },
    });
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenNthCalledWith(2, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.reasoning_delta",
      payload: { messageId: "msg_assistant", delta: " constraints." },
    });
  });

  it("deduplicates overlapping raw and normalized reasoning chunks", async () => {
    const stream = createStream([
      streamPart({
        type: "raw",
        rawValue: {
          choices: [{ delta: { reasoning_content: "Inspecting constraints." } }],
        },
      }),
      streamPart({ type: "reasoning-delta", text: "Inspecting constraints." }),
      streamPart({ type: "text-delta", text: "Visible answer" }),
    ]);

    await expect(collect(stream, { reasoningExposure: "raw" })).resolves.toMatchObject({
      assistantReplayParts: [
        { type: "reasoning", text: "Inspecting constraints." },
        { type: "text", text: "Visible answer" },
      ],
      reasoningContent: "Inspecting constraints.",
    });
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenCalledTimes(2);
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenNthCalledWith(1, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.reasoning_delta",
      payload: { messageId: "msg_assistant", delta: "Inspecting constraints." },
    });
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenNthCalledWith(2, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.delta",
      payload: { messageId: "msg_assistant", delta: "Visible answer" },
    });
  });

  it("stops at a daily spend cap after the step that crosses it, bounding overshoot to one step", async () => {
    const stream = createStream([
      streamPart({ type: "text-delta", text: "working" }),
      streamPart({ type: "finish-step", finishReason: "stop", rawFinishReason: "stop" }),
      // A second step that must never start because the cap check after the first finish-step throws.
      streamPart({ type: "finish-step", finishReason: "stop", rawFinishReason: "stop" }),
    ]);
    const checkSpendCap = vi.fn(async () => ({
      capConfigured: true,
      capUsdMicros: 1_000_000,
      spentTrailing24hUsdMicros: 1_200_000,
      overCap: true,
      remainingUsdMicros: 0,
    }));

    const error = await collect(stream, { checkSpendCap }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RunSpendCapError);
    const capped = error as RunSpendCapError;
    expect(capped.capUsdMicros).toBe(1_000_000);
    expect(capped.spentTrailing24hUsdMicros).toBe(1_200_000);
    // The partial assistant turn is carried so the run can persist a clean point.
    expect(capped.assistantContent).toBe("working");
    // Overshoot bounded to one step: usage recorded once, the second finish-step never ran.
    expect(usageRecorder.recordStepUsage).toHaveBeenCalledTimes(1);
    expect(checkSpendCap).toHaveBeenCalledTimes(1);
    // The stream is torn down on the way out.
    expect(stream.return).toHaveBeenCalledTimes(1);
  });

  it("continues past a finish-step when under the daily spend cap", async () => {
    const stream = createStream([
      streamPart({ type: "finish-step", finishReason: "stop", rawFinishReason: "stop" }),
      streamPart({ type: "text-delta", text: "answer" }),
    ]);
    const checkSpendCap = vi.fn(async () => ({
      capConfigured: true,
      capUsdMicros: 1_000_000,
      spentTrailing24hUsdMicros: 400_000,
      overCap: false,
      remainingUsdMicros: 600_000,
    }));

    await expect(collect(stream, { checkSpendCap })).resolves.toMatchObject({
      assistantContent: "answer",
    });
    expect(checkSpendCap).toHaveBeenCalledTimes(1);
    expect(stream.return).not.toHaveBeenCalled();
  });

  it("persists reasoning phase boundaries without exposing deltas when reasoning is hidden", async () => {
    const stream = createStream([
      streamPart({ type: "reasoning-delta", delta: "Hidden thinking" }),
      streamPart({ type: "text-delta", text: "Visible answer" }),
    ]);

    await collect(stream, { reasoningExposure: "hidden" });

    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenCalledTimes(1);
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenCalledWith({
      sessionId: "ses_123",
      messageId: "msg_assistant",
      type: "message.delta",
      payload: { messageId: "msg_assistant", delta: "Visible answer" },
    });
    expect(leaseWrites.appendRuntimeEventForLease).toHaveBeenNthCalledWith(1, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      leaseId: "run_123",
      leaseOwner: "runner-test",
      type: "message.reasoning_started",
      payload: { messageId: "msg_assistant" },
    });
    expect(leaseWrites.appendRuntimeEventForLease).toHaveBeenNthCalledWith(2, {
      sessionId: "ses_123",
      messageId: "msg_assistant",
      leaseId: "run_123",
      leaseOwner: "runner-test",
      type: "message.reasoning_completed",
      payload: { messageId: "msg_assistant" },
    });
  });
});

function collect(
  stream: ReturnType<typeof createStream>,
  overrides: Partial<Parameters<typeof collectAssistantStream>[0]> = {},
) {
  return collectAssistantStream({
    stream,
    sessionId: "ses_123",
    assistantMessageId: "msg_assistant",
    runLeaseId: "run_123",
    runLeaseOwner: "runner-test",
    modelProvider: "vercel-ai-gateway",
    modelName: "openai/gpt-5.4-mini",
    reasoningExposure: "hidden",
    signal: new AbortController().signal,
    checkAbort: async () => {},
    toolStartCoordinator: createToolStartCoordinator(),
    policy: new Map(),
    suspendable: true,
    ...overrides,
  });
}

function gateHarness() {
  const controller = new AbortController();
  const runState: RunLeaseState = {
    status: "running",
    runLeaseId: "run_123",
    runLeaseOwner: "runner-test",
    runLeaseExpiresAt: new Date("2026-05-29T09:00:00.000Z"),
    runHeartbeatAt: new Date("2026-05-29T08:00:00.000Z"),
    abortRequestedAt: null,
    archivedAt: null,
  };
  const heartbeatAndLoadState = vi.fn().mockResolvedValue(runState);
  const runStore: RunControlStore = {
    claimLease: vi.fn(),
    heartbeatAndLoadState,
    finishLease: vi.fn(),
    releaseLease: vi.fn(),
  };
  const gate = createRunControlGate({
    runLease: { sessionId: "ses_123", leaseId: "run_123", leaseOwner: "runner-test" },
    controller,
    store: runStore,
    intervalMs: 5_000,
    now: () => 0, // freeze the clock so every part stays in the first throttle window
  });
  return { controller, gate, heartbeatAndLoadState };
}

function createStream(
  entries: Array<TextStreamPart<ToolSet> | Error>,
  options: { returnError?: Error } = {},
) {
  const remaining = [...entries];
  const iterator = {
    next: vi.fn(async (): Promise<IteratorResult<TextStreamPart<ToolSet>>> => {
      const entry = remaining.shift();
      if (!entry) return { done: true, value: undefined };
      if (entry instanceof Error) throw entry;
      return { done: false, value: entry };
    }),
    return: vi.fn(async (): Promise<IteratorResult<TextStreamPart<ToolSet>>> => {
      if (options.returnError) throw options.returnError;
      return { done: true, value: undefined };
    }),
  };

  return {
    return: iterator.return,
    [Symbol.asyncIterator]() {
      return iterator;
    },
  } as AsyncIterable<TextStreamPart<ToolSet>> & { return: typeof iterator.return };
}

function streamPart(part: Record<string, unknown>) {
  return part as TextStreamPart<ToolSet>;
}

describe("stream error handling", () => {
  it("records terminal stream metadata from finish-step parts", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);

    async function* stream() {
      yield { type: "text-delta", text: "Working" } as never;
      yield {
        type: "finish-step",
        finishReason: "tool-calls",
        rawFinishReason: "tool_calls",
        response: {
          id: "response_123",
          timestamp: new Date("2026-05-22T12:00:00.000Z"),
          modelId: "openai/gpt-5.4-mini",
        },
        usage: usage(100, 20),
      } as never;
    }

    const result = await collectAssistantStream({
      stream: stream(),
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      reasoningExposure: "hidden",
      signal: new AbortController().signal,
      checkAbort: async () => {},
      toolStartCoordinator: createToolStartCoordinator(),
      policy: new Map(),
      suspendable: true,
    });

    expect(result).toMatchObject({
      assistantContent: "Working",
      stepCount: 1,
      lastFinishReason: "tool-calls",
      lastRawFinishReason: "tool_calls",
      lastStepEndedWithToolCalls: true,
    });
  });

  it("persists pending text before tool starts even when tool input arrives first", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const toolStartCoordinator = createToolStartCoordinator();
    toolStartCoordinator.record({
      toolCallId: "call_search",
      name: "exa_search",
      input: { query: "YC agent discussion" },
    });

    async function* stream() {
      yield { type: "text-delta", text: "I'll search, then distill the" } as never;
      yield {
        type: "tool-call",
        toolCallId: "call_search",
        toolName: "exa_search",
        input: { query: "fallback input" },
      } as never;
      yield { type: "text-delta", text: " themes." } as never;
    }

    await collectAssistantStream({
      stream: stream(),
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      modelProvider: "vercel-ai-gateway",
      modelName: "openai/gpt-5.4-mini",
      reasoningExposure: "hidden",
      signal: new AbortController().signal,
      checkAbort: async () => {},
      toolStartCoordinator,
      policy: new Map(),
      suspendable: true,
    });

    const transientEvents = vi
      .mocked(publishTransientRuntimeEvent)
      .mock.calls.map((call) => call[0]);
    const durableEvents = vi.mocked(appendRuntimeEvent).mock.calls.map((call) => call[1]);
    expect(transientEvents.map((event) => event.type)).toEqual(["message.delta", "message.delta"]);
    expect(durableEvents.map((event) => event.type)).toEqual(["tool.started"]);
    expect(transientEvents[0]).toMatchObject({
      payload: { delta: "I'll search, then distill the" },
    });
    expect(durableEvents[0]).toMatchObject({
      payload: {
        toolCallId: "call_search",
        name: "exa_search",
        input: { query: "YC agent discussion" },
      },
    });
  });

  it("replays tool calls with the parsed coordinator input when the stream part has no input", async () => {
    const toolStartCoordinator = createToolStartCoordinator();
    toolStartCoordinator.record({
      toolCallId: "call_search",
      name: "find_tools",
      input: { query: "", capability: "" },
    });
    const stream = createStream([
      streamPart({
        type: "tool-call",
        toolCallId: "call_search",
        toolName: "find_tools",
        input: undefined,
      }),
    ]);

    const result = await collect(stream, { toolStartCoordinator });

    expect(result.assistantReplayParts).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_search",
        toolName: "find_tools",
        input: { query: "", capability: "" },
      },
    ]);
    expect(
      modelMessageSchema.safeParse(
        buildAssistantModelMessage({ content: "", parts: result.assistantReplayParts }),
      ).success,
    ).toBe(true);
  });

  it("rejects turn completion when the model is still requesting tools at the step cap", () => {
    const streamResult = {
      assistantContent: "Partial progress.",
      assistantReplayParts: [
        {
          type: "tool-call" as const,
          toolCallId: "call_123",
          toolName: "list_files",
          input: {},
        },
      ],
      lastStepEndedWithToolCalls: true,
      stepCount: MAX_MODEL_STEPS,
    };

    expect(isToolStepLimitExceeded(streamResult)).toBe(true);
    expect(() => assertTurnComplete(streamResult)).toThrow(ToolStepLimitExceededError);
  });

  it("uses a 32-step hard cap with a reserved finalization step", () => {
    expect(MAX_MODEL_STEPS).toBe(32);
    expect(SOFT_FINALIZATION_STEP).toBe(31);
  });

  it("keeps normal step settings until the reserved finalization step", () => {
    expect(softFinalizationStepSettings({ stepNumber: 30, system: "Base system." })).toEqual({});
  });

  it("disables tools and appends final-answer guidance on the reserved finalization step", () => {
    const settings = softFinalizationStepSettings({
      stepNumber: SOFT_FINALIZATION_STEP,
      system: "Base system.",
    });

    expect(settings).toMatchObject({
      activeTools: [],
      system: expect.stringContaining("Base system."),
    });
    const system = "system" in settings ? settings.system : "";
    expect(system).toContain("Do not call any more tools");
    expect(system).toContain("provide the best final answer now");
  });

  it("allows normal turns that end with final assistant text", () => {
    expect(() =>
      assertTurnComplete({
        assistantContent: "Done.",
        assistantReplayParts: [{ type: "text", text: "Done." }],
        lastStepEndedWithToolCalls: false,
        stepCount: 2,
      }),
    ).not.toThrow();
  });

  it("allows tool-only turns because the tool call is actionable progress", () => {
    expect(() =>
      assertTurnComplete({
        assistantContent: "",
        assistantReplayParts: [
          {
            type: "tool-call",
            toolCallId: "call_123",
            toolName: "list_files",
            input: {},
          },
        ],
        lastStepEndedWithToolCalls: true,
        stepCount: 1,
      }),
    ).not.toThrow();
  });

  it("rejects reasoning-only turns because they have no user-visible answer", () => {
    expect(() =>
      assertTurnComplete({
        assistantContent: "",
        assistantReplayParts: [{ type: "reasoning", text: "I need answer the user." }],
        lastStepEndedWithToolCalls: false,
        stepCount: 1,
      }),
    ).toThrow("Model stream completed without text or tool calls.");
  });

  it("rejects multi-step turns where the final step produces only reasoning", () => {
    expect(() =>
      assertTurnComplete({
        assistantContent: "",
        assistantReplayParts: [
          { type: "tool-call", toolCallId: "call_1", toolName: "list_files", input: {} },
          { type: "reasoning", text: "Now I should answer." },
        ],
        lastStepEndedWithToolCalls: false,
        stepCount: 2,
      }),
    ).toThrow("Model stream completed without text or tool calls.");
  });

  it("flags a tool-driven turn that stops after announcing an unexecuted action", () => {
    const result = detectIncompleteTurn({
      assistantContent:
        "I scanned the open PRs.\n\nNow let me check the files changed in each PR to assess complexity:",
      assistantReplayParts: [
        { type: "text", text: "I scanned the open PRs." },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "shell",
          input: { cmd: "gh pr list" },
        },
        {
          type: "text",
          text: "Now let me check the files changed in each PR to assess complexity:",
        },
      ],
      lastFinishReason: "stop",
      lastStepEndedWithToolCalls: false,
    });
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("announced_unexecuted_next_action");
    expect(result?.reasonDetail).toMatch(/never took/);
  });

  it("does not flag a genuine completion that used tools and ends with a real answer", () => {
    expect(
      detectIncompleteTurn({
        assistantContent: "Done — 3 PRs reviewed and the Slack notification was sent.",
        assistantReplayParts: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "slack_post",
            input: { text: "report" },
          },
          { type: "text", text: "Done — 3 PRs reviewed and the Slack notification was sent." },
        ],
        lastFinishReason: "stop",
        lastStepEndedWithToolCalls: false,
      }),
    ).toBeNull();
  });

  it("does not flag a colon-terminated reply when the turn never drove a tool", () => {
    expect(
      detectIncompleteTurn({
        assistantContent: "Here are the three options I'd consider:",
        assistantReplayParts: [{ type: "text", text: "Here are the three options I'd consider:" }],
        lastFinishReason: "stop",
        lastStepEndedWithToolCalls: false,
      }),
    ).toBeNull();
  });

  it("does not flag while the model is still requesting tools", () => {
    expect(
      detectIncompleteTurn({
        assistantContent: "Let me check the files changed:",
        assistantReplayParts: [
          { type: "text", text: "Let me check the files changed:" },
          { type: "tool-call", toolCallId: "call_1", toolName: "shell", input: {} },
        ],
        lastFinishReason: "tool-calls",
        lastStepEndedWithToolCalls: true,
      }),
    ).toBeNull();
  });

  it("throws model stream errors instead of allowing blank completions", () => {
    expect(() =>
      throwIfStreamErrorPart({ type: "error", error: new Error("gateway failed") } as never),
    ).toThrow("gateway failed");
  });

  it("throws tool stream errors with a fallback message", () => {
    expect(() =>
      throwIfStreamErrorPart({
        type: "tool-error",
        toolName: "list_files",
        toolCallId: "tool_123",
        input: {},
        error: null,
      } as never),
    ).toThrow("Tool list_files failed.");
  });
});
