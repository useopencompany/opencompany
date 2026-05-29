import type { FinishReason, TextStreamPart, ToolSet } from "ai";
import { appendRuntimeEventForLease } from "./lease-writes";
import { type AssistantReplayPart, appendAssistantTextPart } from "./model-messages";
import { readReasoningTextDelta, throwIfStreamErrorPart } from "./stream-helpers";
import { recordStepUsage } from "./usage-recorder";

// Live assistant text is streamed to the UI as throttled `message.delta` events.
// We deliberately batch deltas (never per-token) so the events table stays small —
// per-token rows were dropped in migration 0011. The client appends these deltas and
// `message.completed` later replaces them with the final content + modelMessage.
const TEXT_DELTA_FLUSH_INTERVAL_MS = 400;

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
}) {
  let assistantContent = "";
  const assistantReplayParts: AssistantReplayPart[] = [];
  let reasoningSummary = "";
  let stepIndex = 0;
  let lastFinishReason: FinishReason | undefined;
  let lastRawFinishReason: string | undefined;

  let pendingDelta = "";
  let lastFlushAt = Date.now();
  const flushTextDelta = async (force: boolean) => {
    if (!pendingDelta) return;
    if (!force && Date.now() - lastFlushAt < TEXT_DELTA_FLUSH_INTERVAL_MS) return;
    const delta = pendingDelta;
    pendingDelta = "";
    lastFlushAt = Date.now();
    // Best-effort: a lost lease is caught by checkAbort; never fail the run on a delta.
    await appendRuntimeEventForLease({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      leaseId: input.runLeaseId,
      leaseOwner: input.runLeaseOwner,
      type: "message.delta",
      payload: { messageId: input.assistantMessageId, delta },
    }).catch(() => false);
  };

  const iterator = input.stream[Symbol.asyncIterator]();
  let next = input.readFirstPart ? await input.readFirstPart(iterator) : await iterator.next();

  while (!next.done) {
    const part = next.value;
    await input.checkAbort();
    throwIfAborted(input.signal);
    throwIfStreamErrorPart(part);

    if (part.type === "text-delta") {
      assistantContent += part.text;
      appendAssistantTextPart(assistantReplayParts, part.text);
      pendingDelta += part.text;
      await flushTextDelta(false);
    }

    if (input.exposeReasoningSummary) {
      reasoningSummary += readReasoningTextDelta(part);
    }

    // Flush buffered text before a tool call so streamed text is ordered ahead of
    // the tool's events in the UI.
    if (part.type === "tool-call") {
      await flushTextDelta(true);
    }

    if (part.type === "finish-step") {
      stepIndex += 1;
      lastFinishReason = part.finishReason;
      lastRawFinishReason = part.rawFinishReason;
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

  await flushTextDelta(true);

  return {
    assistantContent,
    assistantReplayParts,
    reasoningSummary,
    stepCount: stepIndex,
    lastFinishReason,
    lastRawFinishReason,
    lastStepEndedWithToolCalls: lastFinishReason === "tool-calls",
  };
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Run aborted.");
  }
}
