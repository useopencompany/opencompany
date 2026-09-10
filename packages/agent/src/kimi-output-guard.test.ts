import { generateText, jsonSchema, streamText, tool } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { guardKimiOutput, KimiToolCallLeakError } from "./kimi-output-guard";

const nativeCall = '<|open|>tools<|sep|><|open|>call tool="write_artifact" index="1"<|sep|>';
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const finishReason = { unified: "stop" as const, raw: "stop" };
type Part =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer T>
    ? T
    : never;

function streamedModel(chunks: Part[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks, chunkDelayInMs: null }) }),
  });
}

async function consume(chunks: Part[]) {
  const model = guardKimiOutput(streamedModel(chunks), "moonshotai/kimi-k3");
  const result = streamText({ model, prompt: "Write the report.", maxRetries: 0 });
  const parts = [];
  try {
    for await (const part of result.fullStream) parts.push(part);
  } catch (error) {
    parts.push({ type: "error" as const, error });
  }
  return parts;
}

function textChunks(chunks: string[]): Part[] {
  return [
    { type: "text-start", id: "text" },
    ...chunks.map((delta) => ({ type: "text-delta" as const, id: "text", delta })),
    { type: "text-end", id: "text" },
    { type: "finish", usage, finishReason },
  ];
}

describe("Kimi output boundary", () => {
  it("reproduces the unguarded SDK accepting native tool syntax as a successful answer", async () => {
    const execute = vi.fn();
    const result = streamText({
      model: streamedModel(textChunks([nativeCall])),
      prompt: "Write the report.",
      tools: { write_artifact: tool({ inputSchema: jsonSchema({ type: "object" }), execute }) },
      activeTools: [],
      toolChoice: "none",
    });
    expect(await result.text).toBe(nativeCall);
    expect(await result.finishReason).toBe("stop");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(Array.from({ length: 19 }, (_, index) => index + 1))(
    "rejects a native call split at offset %i before publishing any syntax",
    async (offset) => {
      const parts = await consume(
        textChunks([nativeCall.slice(0, offset), nativeCall.slice(offset)]),
      );
      expect(parts.filter((part) => part.type === "text-delta")).toEqual([]);
      expect(parts.find((part) => part.type === "error")).toMatchObject({
        error: expect.any(KimiToolCallLeakError),
      });
    },
  );

  it("detects one-character chunks and leading whitespace", async () => {
    const parts = await consume(textChunks([...` \n${nativeCall}`]));
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.text)
        .join(""),
    ).toBe(" \n");
    expect(parts.some((part) => part.type === "error")).toBe(true);
  });

  it.each([
    "A normal answer",
    "<div>Hello</div>",
    "<|open",
    `Example: ${nativeCall}`,
    `\`\`\`text\n${nativeCall}\n\`\`\``,
  ])("preserves ordinary text and protocol examples: %s", async (text) => {
    const parts = await consume(textChunks([...text]));
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.text)
        .join(""),
    ).toBe(text);
    expect(parts.some((part) => part.type === "error")).toBe(false);
  });

  it("preserves structured tool calls and reasoning unchanged", async () => {
    const parts = await consume([
      { type: "reasoning-start", id: "reason" },
      { type: "reasoning-delta", id: "reason", delta: nativeCall },
      { type: "reasoning-end", id: "reason" },
      { type: "tool-call", toolCallId: "call_1", toolName: "write_artifact", input: "{}" },
      { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
    ]);
    expect(parts.find((part) => part.type === "reasoning-delta")).toMatchObject({
      text: nativeCall,
    });
    expect(parts.find((part) => part.type === "tool-call")).toMatchObject({ toolCallId: "call_1" });
    expect(parts.some((part) => part.type === "error")).toBe(false);
  });

  it("checks each new text block even after an ordinary response", async () => {
    const parts = await consume([
      ...textChunks(["Progress update."]).slice(0, -1),
      ...textChunks([nativeCall]),
    ]);
    expect(parts.some((part) => part.type === "error")).toBe(true);
    expect(
      parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.text)
        .join(""),
    ).toBe("Progress update.");
  });

  it("rejects native calls on the non-streaming path too", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: nativeCall }],
        usage,
        finishReason,
        warnings: [],
      }),
    });
    await expect(
      generateText({
        model: guardKimiOutput(model, "moonshotai/kimi-k3"),
        prompt: "Report",
        maxRetries: 0,
      }),
    ).rejects.toBeInstanceOf(KimiToolCallLeakError);
  });

  it("never executes a structured call that violates final-step toolChoice none", async () => {
    const execute = vi.fn();
    const model = streamedModel([
      { type: "tool-call", toolCallId: "call_1", toolName: "write_artifact", input: "{}" },
      { type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
    ]);
    const result = streamText({
      model: guardKimiOutput(model, "moonshotai/kimi-k3"),
      prompt: "Give the final answer.",
      tools: { write_artifact: tool({ inputSchema: jsonSchema({ type: "object" }), execute }) },
      toolChoice: "none",
      maxRetries: 0,
    });
    await expect(
      result.consumeStream({
        onError: (error) => {
          throw error;
        },
      }),
    ).rejects.toBeInstanceOf(KimiToolCallLeakError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaves other model adapters unchanged", () => {
    const model = streamedModel([]);
    expect(guardKimiOutput(model, "moonshotai/kimi-k2.6")).toBe(model);
    expect(guardKimiOutput(model, "anthropic/claude-sonnet-4.6")).toBe(model);
  });
});
