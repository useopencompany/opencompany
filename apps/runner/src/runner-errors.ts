import type { AssistantReplayPart } from "./model-messages";

export const TOOL_STEP_LIMIT_EXCEEDED_MESSAGE =
  "Agent reached the tool-step limit before producing a final answer. Send another message to continue.";

export class ToolStepLimitExceededError extends Error {
  constructor(message = TOOL_STEP_LIMIT_EXCEEDED_MESSAGE) {
    super(message);
    this.name = "ToolStepLimitExceededError";
  }
}

// Thrown out of the model stream when a tool call hits an "ask" gate. It is not a
// failure: it carries the partial assistant turn (text + the pending tool-call) so the
// run can persist a clean suspension point, release its lease, and set the session to
// `awaiting_approval`. The run resumes in a fresh `resume_approval` job once the user
// (or the 7-day backstop) decides. Non-retryable at the job layer — a retry would just
// re-suspend.
export class RunSuspendedError extends Error {
  readonly toolCallId: string;
  readonly providerKey: string;
  readonly group: "read" | "post" | "modify" | "admin";
  readonly assistantContent: string;
  readonly assistantReplayParts: AssistantReplayPart[];
  readonly reasoningSummary: string;
  readonly reasoningContent: string;

  constructor(input: {
    toolCallId: string;
    providerKey: string;
    group: "read" | "post" | "modify" | "admin";
    assistantContent: string;
    assistantReplayParts: AssistantReplayPart[];
    reasoningSummary: string;
    reasoningContent: string;
  }) {
    super("Run suspended for tool approval.");
    this.name = "RunSuspendedError";
    this.toolCallId = input.toolCallId;
    this.providerKey = input.providerKey;
    this.group = input.group;
    this.assistantContent = input.assistantContent;
    this.assistantReplayParts = input.assistantReplayParts;
    this.reasoningSummary = input.reasoningSummary;
    this.reasoningContent = input.reasoningContent;
  }
}

export function isNonRetryableRunnerError(error: unknown) {
  return error instanceof ToolStepLimitExceededError || error instanceof RunSuspendedError;
}
