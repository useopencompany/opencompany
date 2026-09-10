import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from "ai";

const TOOLS_PREFIX = "<|open|>tools<|sep|>";

export class KimiToolCallLeakError extends Error {
  constructor() {
    super(
      "The model returned an unexecuted tool call instead of an answer. Please retry the request.",
    );
    this.name = "KimiToolCallLeakError";
  }
}

// Native tool syntax at the start of a response is a provider protocol failure.
// Never turn it into an executable call or a successful user-visible answer.
// Inline examples and fenced code remain ordinary text.
const kimiOutputGuard: LanguageModelMiddleware = {
  wrapGenerate: async ({ doGenerate, params }) => {
    const result = await doGenerate();
    for (const part of result.content) {
      if (part.type === "tool-call" && params.toolChoice?.type === "none") {
        throw new KimiToolCallLeakError();
      }
      if (part.type === "text" && part.text.trimStart().startsWith(TOOLS_PREFIX)) {
        throw new KimiToolCallLeakError();
      }
    }
    return result;
  },
  wrapStream: async ({ doStream, params }) => {
    const result = await doStream();
    type Part = typeof result.stream extends ReadableStream<infer T> ? T : never;
    type TextDelta = Extract<Part, { type: "text-delta" }>;
    const pending = new Map<string, TextDelta>();
    const checked = new Set<string>();
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream<Part, Part>({
          transform(part, controller) {
            if (
              params.toolChoice?.type === "none" &&
              (part.type === "tool-call" || part.type === "tool-input-start")
            ) {
              throw new KimiToolCallLeakError();
            }
            if (part.type === "text-delta" && !checked.has(part.id)) {
              const delta = `${pending.get(part.id)?.delta ?? ""}${part.delta}`;
              const prefix = delta.trimStart();
              if (prefix.startsWith(TOOLS_PREFIX)) throw new KimiToolCallLeakError();
              if (prefix && TOOLS_PREFIX.startsWith(prefix)) {
                pending.set(part.id, { ...part, delta });
                return;
              }
              pending.delete(part.id);
              if (prefix) checked.add(part.id);
              controller.enqueue({ ...part, delta });
              return;
            }
            if (part.type === "text-end") {
              const buffered = pending.get(part.id);
              if (buffered) controller.enqueue(buffered);
              pending.delete(part.id);
              checked.delete(part.id);
            }
            controller.enqueue(part);
          },
          flush(controller) {
            for (const part of pending.values()) controller.enqueue(part);
          },
        }),
      ),
    };
  },
};

export function guardKimiOutput(model: LanguageModel, modelId: string): LanguageModel {
  if (modelId !== "moonshotai/kimi-k3" || typeof model === "string") return model;
  return wrapLanguageModel({ model, middleware: kimiOutputGuard });
}
