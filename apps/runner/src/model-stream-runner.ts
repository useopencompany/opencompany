import type { TextStreamPart, ToolSet } from "ai";
import { type AssistantReplayPart, appendAssistantTextPart } from "./model-messages";
import { readReasoningTextDelta, throwIfStreamErrorPart } from "./stream-helpers";
import { recordStepUsage } from "./usage-recorder";

export async function collectAssistantStream(input: {
  stream: AsyncIterable<TextStreamPart<ToolSet>>;
  readFirstPart?: (
    iterator: AsyncIterator<TextStreamPart<ToolSet>>,
  ) => Promise<IteratorResult<TextStreamPart<ToolSet>>>;
  sessionId: string;
  assistantMessageId: string;
  runLeaseId: string;
  runLeaseOwner: string;
  modelProvider: string;
  modelName: string;
  exposeReasoningSummary: boolean;
  signal: AbortSignal;
  checkAbort: () => Promise<void>;
  onFirstOutputPart?: () => void;
}) {
  let assistantContent = "";
  const assistantReplayParts: AssistantReplayPart[] = [];
  let reasoningSummary = "";
  let stepIndex = 0;
  let sawOutputPart = false;
  const modelSteps: Array<{
    stepIndex: number;
    finishReason: unknown;
    rawFinishReason: unknown;
    usage: unknown;
    response: unknown;
  }> = [];

  const iterator = input.stream[Symbol.asyncIterator]();
  let completedNaturally = false;

  try {
    let next = input.readFirstPart ? await input.readFirstPart(iterator) : await iterator.next();

    while (!next.done) {
      const part = next.value;
      await input.checkAbort();
      throwIfAborted(input.signal);
      throwIfStreamErrorPart(part);

      if (!sawOutputPart && isModelOutputPart(part)) {
        sawOutputPart = true;
        input.onFirstOutputPart?.();
      }

      if (part.type === "text-delta") {
        assistantContent += part.text;
        appendAssistantTextPart(assistantReplayParts, part.text);
      }

      if (input.exposeReasoningSummary) {
        reasoningSummary += readReasoningTextDelta(part);
      }

      if (part.type === "finish-step") {
        stepIndex += 1;
        modelSteps.push({
          stepIndex,
          finishReason: part.finishReason,
          rawFinishReason: part.rawFinishReason,
          usage: part.usage,
          response: part.response,
        });
        await recordStepUsage({
          sessionId: input.sessionId,
          assistantMessageId: input.assistantMessageId,
          runLeaseId: input.runLeaseId,
          runLeaseOwner: input.runLeaseOwner,
          stepIndex,
          modelProvider: input.modelProvider,
          modelName: input.modelName,
          response: part.response,
          usage: part.usage,
          finishReason: part.finishReason,
          rawFinishReason: part.rawFinishReason,
        });
      }

      if (part.type === "tool-call") {
        assistantReplayParts.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
      }

      next = await iterator.next();
    }

    completedNaturally = true;
  } finally {
    if (!completedNaturally) {
      try {
        await iterator.return?.();
      } catch {
        // Preserve the original stream/model/lease failure.
      }
    }
  }

  return { assistantContent, assistantReplayParts, reasoningSummary, modelSteps };
}

function isModelOutputPart(part: TextStreamPart<ToolSet>) {
  return part.type === "text-delta" || part.type === "reasoning-delta" || part.type === "tool-call";
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Run aborted.");
  }
}
