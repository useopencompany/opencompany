export const TOOL_STEP_LIMIT_EXCEEDED_MESSAGE =
  "Agent reached the tool-step limit before producing a final answer. Send another message to continue.";

export class ToolStepLimitExceededError extends Error {
  constructor(message = TOOL_STEP_LIMIT_EXCEEDED_MESSAGE) {
    super(message);
    this.name = "ToolStepLimitExceededError";
  }
}

export function isNonRetryableRunnerError(error: unknown) {
  return error instanceof ToolStepLimitExceededError;
}
