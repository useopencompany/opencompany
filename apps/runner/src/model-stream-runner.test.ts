import type { TextStreamPart, ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectAssistantStream } from "./model-stream-runner";
import { createToolStartCoordinator } from "./tool-start-coordinator";

const usageRecorder = vi.hoisted(() => ({
  recordStepUsage: vi.fn(async () => {}),
}));

vi.mock("./usage-recorder", () => usageRecorder);

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
    exposeReasoningSummary: false,
    signal: new AbortController().signal,
    checkAbort: async () => {},
    toolStartCoordinator: createToolStartCoordinator(),
    ...overrides,
  });
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
