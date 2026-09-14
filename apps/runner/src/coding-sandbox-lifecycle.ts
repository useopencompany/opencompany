export const DEFAULT_CODING_AGENT_TURN_TIMEOUT_MS = 3 * 60 * 60 * 1000;
export const CODING_SANDBOX_TURN_GRACE_MS = 15 * 60 * 1000;
export const ACTIVE_CODING_SANDBOX_TIMEOUT_MS =
  DEFAULT_CODING_AGENT_TURN_TIMEOUT_MS + CODING_SANDBOX_TURN_GRACE_MS;
export const FINISHED_TASK_SANDBOX_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export function settledCodingSandboxIdleTimeoutMs(input: {
  configuredIdleTimeoutMs: number;
  taskSession: boolean;
}) {
  if (!input.taskSession) return input.configuredIdleTimeoutMs;
  return Math.min(input.configuredIdleTimeoutMs, FINISHED_TASK_SANDBOX_IDLE_TIMEOUT_MS);
}
