import type { FinishReason, TextStreamPart, ToolSet } from "ai";
import { publishTransientRuntimeEvent } from "./events";
import { appendRuntimeEventForLease, requireLeaseWrite } from "./lease-writes";
import { type AssistantReplayPart, appendAssistantTextPart } from "./model-messages";
import { readReasoningTextDelta, throwIfStreamErrorPart } from "./stream-helpers";
import type { ToolStartCoordinator } from "./tool-start-coordinator";
import { recordStepUsage } from "./usage-recorder";

// Live assistant text is transient-only, so publish model deltas as they arrive.
// The database only stores durable message boundaries and final content.

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
  toolStartCoordinator: ToolStartCoordinator;
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
  let lastFinishReason: FinishReason | undefined;
  let lastRawFinishReason: string | undefined;

  const publishTextDelta = (delta: string) => {
    if (!delta) return;
    publishTransientRuntimeEvent({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      type: "message.delta",
      payload: { messageId: input.assistantMessageId, delta },
    });
  };

  // Reasoning streams as its own transient `message.reasoning_delta` events so the UI can
  // show a live "Thinking…" label only while the model is actually reasoning. The final
  // reasoning summary still lands separately at message completion.
  const publishReasoningDelta = (delta: string) => {
    if (!delta) return;
    publishTransientRuntimeEvent({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      type: "message.reasoning_delta",
      payload: { messageId: input.assistantMessageId, delta },
    });
  };
  let reasoningPhaseOpen = false;

  const startReasoningPhase = async () => {
    if (reasoningPhaseOpen) return;
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.runLeaseId,
        leaseOwner: input.runLeaseOwner,
        type: "message.reasoning_started",
        payload: { messageId: input.assistantMessageId },
      }),
    );
    reasoningPhaseOpen = true;
  };

  const completeReasoningPhase = async () => {
    if (!reasoningPhaseOpen) return;
    await requireLeaseWrite(
      appendRuntimeEventForLease({
        sessionId: input.sessionId,
        messageId: input.assistantMessageId,
        leaseId: input.runLeaseId,
        leaseOwner: input.runLeaseOwner,
        type: "message.reasoning_completed",
        payload: { messageId: input.assistantMessageId },
      }),
    );
    reasoningPhaseOpen = false;
  };

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

      const reasoningDelta = readReasoningTextDelta(part);

      if (part.type === "text-delta") {
        await completeReasoningPhase();
        assistantContent += part.text;
        appendAssistantTextPart(assistantReplayParts, part.text);
        publishTextDelta(part.text);
      }

      if (reasoningDelta) {
        await startReasoningPhase();
        if (input.exposeReasoningSummary) {
          reasoningSummary += reasoningDelta;
          publishReasoningDelta(reasoningDelta);
        }
      }

      if (part.type === "finish-step") {
        await completeReasoningPhase();
        stepIndex += 1;
        lastFinishReason = part.finishReason;
        lastRawFinishReason = part.rawFinishReason;
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
        await completeReasoningPhase();
        const toolStart = input.toolStartCoordinator.read(part.toolCallId) ?? {
          toolCallId: part.toolCallId,
          name: part.toolName,
          input: part.input,
        };
        await requireLeaseWrite(
          appendRuntimeEventForLease({
            sessionId: input.sessionId,
            messageId: input.assistantMessageId,
            leaseId: input.runLeaseId,
            leaseOwner: input.runLeaseOwner,
            type: "tool.started",
            payload: {
              messageId: input.assistantMessageId,
              toolCallId: part.toolCallId,
              name: toolStart.name,
              input: toolStart.input,
            },
          }),
        );
        input.toolStartCoordinator.markStarted(part.toolCallId);
        assistantReplayParts.push({
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
      }

      next = await iterator.next();
    }

    await completeReasoningPhase();
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

  return {
    assistantContent,
    assistantReplayParts,
    reasoningSummary,
    modelSteps,
    stepCount: stepIndex,
    lastFinishReason,
    lastRawFinishReason,
    lastStepEndedWithToolCalls: lastFinishReason === "tool-calls",
  };
}

function isModelOutputPart(part: TextStreamPart<ToolSet>) {
  return part.type === "text-delta" || part.type === "reasoning-delta" || part.type === "tool-call";
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Run aborted.");
  }
}
