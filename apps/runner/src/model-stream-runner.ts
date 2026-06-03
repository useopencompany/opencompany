import { resolveToolDecision, type WorkspaceToolPolicyMap } from "@opencompany/agent-runtime";
import type { FinishReason, TextStreamPart, ToolSet } from "ai";
import { publishTransientRuntimeEvent } from "./events";
import {
  appendRuntimeEventForLease,
  insertSessionQuestionForLease,
  insertToolApprovalForLease,
  requireLeaseWrite,
} from "./lease-writes";
import {
  type AssistantReplayPart,
  appendAssistantReasoningPart,
  appendAssistantTextPart,
} from "./model-messages";
import type { RunControlCheck } from "./run-control";
import { RunSuspendedError } from "./runner-errors";
import { normalizeQuestionsInput } from "./session-questions";
import { readReasoningTextDelta, throwIfStreamErrorPart } from "./stream-helpers";
import { formatRuntimePreview } from "./tool-dispatcher";
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
  reasoningExposure: "hidden" | "summary" | "raw";
  signal: AbortSignal;
  checkAbort: RunControlCheck;
  toolStartCoordinator: ToolStartCoordinator;
  policy: WorkspaceToolPolicyMap;
  // Whether this run can durably suspend for an "ask" approval. Top-level user and
  // scheduled runs can (they have a resumable session a human can approve in). Delegated
  // children and after-session/background runs cannot, so their "ask" collapses to "deny".
  suspendable: boolean;
  onFirstOutputPart?: () => void;
}) {
  let assistantContent = "";
  const assistantReplayParts: AssistantReplayPart[] = [];
  let reasoningSummary = "";
  let reasoningContent = "";
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

  // Reasoning streams as its own transient `message.reasoning_delta` events when the model's
  // reasoning is intentionally exposed. Raw Kimi reasoning is persisted separately from
  // summary-style reasoning so the UI can label it honestly.
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

      const reasoningDelta = readReasoningTextDelta(part);

      if (!sawOutputPart && isModelOutputPart(part, reasoningDelta)) {
        sawOutputPart = true;
        input.onFirstOutputPart?.();
      }

      if (part.type === "text-delta") {
        await completeReasoningPhase();
        assistantContent += part.text;
        appendAssistantTextPart(assistantReplayParts, part.text);
        publishTextDelta(part.text);
      }

      if (reasoningDelta) {
        await startReasoningPhase();
        if (input.reasoningExposure === "summary") {
          reasoningSummary += reasoningDelta;
          publishReasoningDelta(reasoningDelta);
        } else if (input.reasoningExposure === "raw") {
          const uniqueDelta = uniqueReasoningDelta(reasoningContent, reasoningDelta);
          if (uniqueDelta) {
            reasoningContent += uniqueDelta;
            appendAssistantReasoningPart(assistantReplayParts, uniqueDelta);
            publishReasoningDelta(uniqueDelta);
          }
        }
      }

      if (part.type === "finish-step") {
        // A model step boundary is a natural place to reconcile run-control state,
        // so force a fresh check rather than waiting out the hot-path throttle.
        await input.checkAbort({ force: true });
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

        // ask_user_question suspends the run for structured user input, independent of the
        // workspace tool policy. It only suspends on a resumable (suspendable) run with usable
        // questions; otherwise it falls through to the normal path so the tool's execute() body
        // returns a "cannot ask the user here" result and the model adapts.
        if (toolStart.name === "ask_user_question" && input.suspendable) {
          const questions = normalizeQuestionsInput(toolStart.input);
          if (questions) {
            await insertSessionQuestionForLease({
              sessionId: input.sessionId,
              messageId: input.assistantMessageId,
              toolCallId: part.toolCallId,
              questions,
              leaseId: input.runLeaseId,
              leaseOwner: input.runLeaseOwner,
            });
            await requireLeaseWrite(
              appendRuntimeEventForLease({
                sessionId: input.sessionId,
                messageId: input.assistantMessageId,
                leaseId: input.runLeaseId,
                leaseOwner: input.runLeaseOwner,
                type: "question.requested",
                payload: {
                  messageId: input.assistantMessageId,
                  toolCallId: part.toolCallId,
                  questions,
                  requestedAt: new Date().toISOString(),
                },
              }),
            );
            // Persist the assistant message ending in this pending tool-call so the resume run
            // can pair it with the synthesized tool-result. Release every parked tool call with a
            // no-op suspend verdict, then unwind to suspend the run for input.
            assistantReplayParts.push({
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            });
            input.toolStartCoordinator.suspend();
            throw new RunSuspendedError({
              reason: "question",
              toolCallId: part.toolCallId,
              providerKey: "system",
              group: "read",
              questions,
              assistantContent,
              assistantReplayParts,
              reasoningSummary,
              reasoningContent,
            });
          }
        }

        // Evaluate the workspace permission policy for this tool call. This is the
        // hard gate: the tool's execute() is parked on waitForStarted() and only the
        // verdict we attach via markStarted() decides whether the real body runs.
        const { decision, providerKey, group, denialSource } = resolveToolDecision({
          toolName: toolStart.name,
          policy: input.policy,
          suspendable: input.suspendable,
        });

        const toolCallReplayPart: AssistantReplayPart = {
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        };

        if (decision === "ask") {
          // Durably suspend the run for a human decision. Persist the approval row (the
          // source of truth the web action / backstop update) and emit the event that
          // drives the in-chat Approve/Deny buttons. We do NOT block here: the run unwinds
          // via RunSuspendedError, the lease is released, and the tool body runs later in
          // a fresh resume run once the approval is decided.
          await insertToolApprovalForLease({
            sessionId: input.sessionId,
            messageId: input.assistantMessageId,
            toolCallId: part.toolCallId,
            toolName: toolStart.name,
            providerKey,
            permissionGroup: group,
            inputPreview: formatRuntimePreview(toolStart.input),
            leaseId: input.runLeaseId,
            leaseOwner: input.runLeaseOwner,
          });
          const requestedAtMs = Date.now();
          await requireLeaseWrite(
            appendRuntimeEventForLease({
              sessionId: input.sessionId,
              messageId: input.assistantMessageId,
              leaseId: input.runLeaseId,
              leaseOwner: input.runLeaseOwner,
              type: "tool.approval_required",
              payload: {
                messageId: input.assistantMessageId,
                toolCallId: part.toolCallId,
                name: toolStart.name,
                providerKey,
                permissionGroup: group,
                inputPreview: formatRuntimePreview(toolStart.input),
                requestedAt: new Date(requestedAtMs).toISOString(),
              },
            }),
          );

          // The persisted assistant message must end in this pending tool-call so the
          // resume run can pair it with the tool-result. Release every parked tool call
          // (this one + any concurrent siblings of the step) with a no-op suspend verdict
          // so none hang, then unwind to suspend the run.
          assistantReplayParts.push(toolCallReplayPart);
          input.toolStartCoordinator.suspend();
          throw new RunSuspendedError({
            toolCallId: part.toolCallId,
            providerKey,
            group,
            assistantContent,
            assistantReplayParts,
            reasoningSummary,
            reasoningContent,
          });
        }

        // allow / deny: emit tool.started and release execute() with the verdict. A
        // denied call returns a permission_denied result instead of running its body.
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
        // Pass the specific denial source so persistDeniedToolResult can emit a precise
        // error message. For allowed tools denialSource is undefined — that's fine, the
        // field is only used when decision === "deny".
        input.toolStartCoordinator.markStarted(part.toolCallId, {
          decision,
          providerKey,
          group,
          source: denialSource ?? "policy",
        });

        assistantReplayParts.push(toolCallReplayPart);
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
    reasoningContent,
    modelSteps,
    stepCount: stepIndex,
    lastFinishReason,
    lastRawFinishReason,
    lastStepEndedWithToolCalls: lastFinishReason === "tool-calls",
  };
}

function isModelOutputPart(part: TextStreamPart<ToolSet>, reasoningDelta: string) {
  return part.type === "text-delta" || Boolean(reasoningDelta) || part.type === "tool-call";
}

function uniqueReasoningDelta(current: string, next: string) {
  if (!current || !next) return next;
  if (current.endsWith(next)) return "";
  const maxOverlap = Math.min(current.length, next.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (current.endsWith(next.slice(0, size))) return next.slice(size);
  }
  return next;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Run aborted.");
  }
}
