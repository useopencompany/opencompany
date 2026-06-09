// Keep this message in sync with TOOL_STEP_LIMIT_EXCEEDED_MESSAGE in
// apps/runner/src/runner-errors.ts — this value is matched by string equality against the runner's error message.
export const TOOL_STEP_LIMIT_EXCEEDED_MESSAGE =
  "Agent reached the tool-step limit before producing a final answer. Send another message to continue.";

export function isToolStepLimitResumable(input: {
  status: string;
  lastError: string | null | undefined;
}) {
  return input.status === "failed" && input.lastError === TOOL_STEP_LIMIT_EXCEEDED_MESSAGE;
}

export function isSessionContinuable(input: {
  status: string;
  lastError: string | null | undefined;
}) {
  return input.status === "interrupted" || isToolStepLimitResumable(input);
}
