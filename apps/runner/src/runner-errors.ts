import type { AgentSessionQuestionPrompt } from "@opencompany/agent-runtime";

import type { AssistantReplayPart } from "./model-messages";

// Keep this message in sync with TOOL_STEP_LIMIT_EXCEEDED_MESSAGE in
// apps/web/lib/agent-sessions/resumable.ts — the web layer matches against it by string equality.
export const TOOL_STEP_LIMIT_EXCEEDED_MESSAGE =
  "Agent reached the tool-step limit before producing a final answer. Send another message to continue.";

export class ToolStepLimitExceededError extends Error {
  constructor(message = TOOL_STEP_LIMIT_EXCEEDED_MESSAGE) {
    super(message);
    this.name = "ToolStepLimitExceededError";
  }
}

// Wraps any failure that surfaces *after* a run acquired its execution lease and began the
// model/tool loop — for message, after_session, and resume_approval/resume_question jobs.
// Once a run is past the lease it may already have executed tool calls with external side
// effects (brain writes, GitHub sync, outbound messages). Retrying the job would replay the
// whole turn from persisted history and double-run those side effects, so this is treated as
// non-retryable at the job layer (see isNonRetryableRunnerError). Failures *before* the lease
// (load/credit/lease-busy) stay raw and remain retryable. The original error is preserved on
// `cause` and its message is surfaced so the job's lastError stays meaningful.
export class MessageTurnFailedError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Message turn failed.");
    this.name = "MessageTurnFailedError";
    this.cause = cause;
  }
}

// Thrown out of the model stream when a turn must suspend for a human. Two reasons:
//   - "approval": a tool call hit an "ask" gate (resumes in a `resume_approval` job).
//   - "question": the model called ask_user_question (resumes in a `resume_question` job).
// It is not a failure: it carries the partial assistant turn (text + the pending tool-call) so
// the run can persist a clean suspension point, release its lease, and set the session to
// `awaiting_approval` / `awaiting_input`. The run resumes once the user (or the 7-day backstop)
// decides. Non-retryable at the job layer — a retry would just re-suspend. For "question" the
// providerKey/group fields are unused placeholders ("system"/"read").
export class RunSuspendedError extends Error {
  readonly reason: "approval" | "question";
  readonly toolCallId: string;
  readonly providerKey: string;
  readonly group: "read" | "post" | "modify" | "admin";
  readonly questions: AgentSessionQuestionPrompt[] | undefined;
  readonly assistantContent: string;
  readonly assistantReplayParts: AssistantReplayPart[];
  readonly reasoningSummary: string;
  readonly reasoningContent: string;

  constructor(input: {
    reason?: "approval" | "question";
    toolCallId: string;
    providerKey: string;
    group: "read" | "post" | "modify" | "admin";
    questions?: AgentSessionQuestionPrompt[];
    assistantContent: string;
    assistantReplayParts: AssistantReplayPart[];
    reasoningSummary: string;
    reasoningContent: string;
  }) {
    super(
      input.reason === "question"
        ? "Run suspended for user question."
        : "Run suspended for tool approval.",
    );
    this.name = "RunSuspendedError";
    this.reason = input.reason ?? "approval";
    this.toolCallId = input.toolCallId;
    this.providerKey = input.providerKey;
    this.group = input.group;
    this.questions = input.questions;
    this.assistantContent = input.assistantContent;
    this.assistantReplayParts = input.assistantReplayParts;
    this.reasoningSummary = input.reasoningSummary;
    this.reasoningContent = input.reasoningContent;
  }
}

export function isNonRetryableRunnerError(error: unknown) {
  return (
    error instanceof ToolStepLimitExceededError ||
    error instanceof RunSuspendedError ||
    error instanceof MessageTurnFailedError
  );
}
