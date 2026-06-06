import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "./agent-loop-test-support";

const braintrustMocks = vi.hoisted(() => ({
  getBraintrustAISDK: vi.fn(),
  traceBraintrustStep: vi.fn(
    async (
      _name: string,
      run: (span: { log: (fields: unknown) => void } | undefined) => Promise<unknown>,
    ) => run({ log: vi.fn() }),
  ),
}));

const sandboxMocks = vi.hoisted(() => ({
  runSandboxTool: vi.fn(async () => ({ stdout: "file contents", stderr: "", exitCode: 0 })),
}));

const usageMocks = vi.hoisted(() => ({
  recordStepUsage: vi.fn(async () => {}),
}));

const eventMocks = vi.hoisted(() => ({
  publishTransientRuntimeEvent: vi.fn((event) => ({ ...event, id: null, transient: true })),
}));

vi.mock("@opencompany/observability/braintrust", () => braintrustMocks);
vi.mock("./sandbox", () => sandboxMocks);
vi.mock("./usage-recorder", () => usageMocks);
vi.mock("./events", () => eventMocks);

import { createExploreHandler } from "./explore";

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const RESPONSE = { id: "resp_1", modelId: "anthropic/claude-haiku-4.5", timestamp: new Date(0) };

// Drives a scripted inner stream: exercises a sandbox read to prove wiring, streams text, and
// emits two finish-step boundaries carrying usage.
function scriptedStreamText(finalText: string) {
  return vi.fn(
    (args: { tools: { read_file: { execute: (i: unknown, o: unknown) => unknown } } }) => ({
      fullStream: (async function* () {
        await args.tools.read_file.execute({ path: "brain/README.md" }, { toolCallId: "inner_1" });
        yield { type: "text-delta", text: finalText.slice(0, 3) };
        yield {
          type: "finish-step",
          usage: USAGE,
          response: RESPONSE,
          finishReason: "tool-calls",
          rawFinishReason: "tool_use",
        };
        yield { type: "text-delta", text: finalText.slice(3) };
        yield {
          type: "finish-step",
          usage: USAGE,
          response: RESPONSE,
          finishReason: "stop",
          rawFinishReason: "end_turn",
        };
      })(),
      text: Promise.resolve(finalText),
    }),
  );
}

function handler(signal = new AbortController().signal) {
  return createExploreHandler({
    parentSessionId: "ses_parent",
    parentMessageId: "msg_parent",
    parentRunLeaseId: "run_parent",
    parentRunLeaseOwner: "runner-test",
    getSandbox: async () => ({}) as never,
    workdir: "/home/user/workspace",
    env: env(),
    signal,
    checkAbort: async () => {},
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("explore sub-agent", () => {
  it("returns the distilled summary, reads the sandbox, streams progress, and rolls up usage", async () => {
    braintrustMocks.getBraintrustAISDK.mockReturnValue({
      streamText: scriptedStreamText("Brain says the launch is Tuesday."),
    });

    const result = await handler()({ task: "When is launch?", toolCallId: "call_explore" });

    expect(result).toEqual({ ok: true, summary: "Brain says the launch is Tuesday." });

    // Inner tool reached the SAME sandbox via runSandboxTool, not the parent tool set.
    expect(sandboxMocks.runSandboxTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "read_file", args: { path: "brain/README.md" } }),
    );

    // Coarse progress streamed to the parent message as command.output.
    expect(eventMocks.publishTransientRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ses_parent",
        messageId: "msg_parent",
        type: "command.output",
      }),
    );

    // Inner model usage attributed to the PARENT turn on the cheap explore model.
    expect(usageMocks.recordStepUsage).toHaveBeenCalledTimes(2);
    expect(usageMocks.recordStepUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ses_parent",
        assistantMessageId: "msg_parent",
        runLeaseId: "run_parent",
        modelName: "anthropic/claude-haiku-4.5",
      }),
    );
  });

  it("fails cleanly when the explorer produces no summary", async () => {
    braintrustMocks.getBraintrustAISDK.mockReturnValue({ streamText: scriptedStreamText("   ") });

    const result = await handler()({ task: "anything", toolCallId: "call_explore" });

    expect(result).toMatchObject({ ok: false });
  });

  it("converts errors to a recoverable tool result", async () => {
    braintrustMocks.getBraintrustAISDK.mockReturnValue({
      streamText: vi.fn(() => {
        throw new Error("gateway exploded");
      }),
    });

    const result = await handler()({ task: "anything", toolCallId: "call_explore" });

    expect(result).toEqual({ ok: false, error: "gateway exploded" });
  });

  it("rethrows when the parent run was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    braintrustMocks.getBraintrustAISDK.mockReturnValue({
      streamText: vi.fn(() => {
        throw new Error("aborted mid-stream");
      }),
    });

    await expect(handler(controller.signal)({ task: "x", toolCallId: "c" })).rejects.toThrow(
      "aborted mid-stream",
    );
  });
});
