import type { TextStreamPart, ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectAssistantStream } from "./model-stream-runner";
import {
  createRunControlGate,
  RunAbortError,
  type RunControlStore,
  type RunLeaseState,
} from "./run-control";
import { createToolStartCoordinator } from "./tool-start-coordinator";

const usageRecorder = vi.hoisted(() => ({
  recordStepUsage: vi.fn(async () => {}),
}));
const eventMocks = vi.hoisted(() => ({
  publishTransientRuntimeEvent: vi.fn(),
}));
const leaseWrites = vi.hoisted(() => ({
  appendRuntimeEventForLease: vi.fn(async () => true),
  requireLeaseWrite: vi.fn(async (value: unknown) => value),
}));

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
