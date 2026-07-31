export const GOAT_FINISHED_TASK_SANDBOX_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export function settledGoatCodingSandboxIdleTimeoutMs(input: {
  configuredIdleTimeoutMs: number;
  taskSession: boolean;
}) {
  if (!input.taskSession) return input.configuredIdleTimeoutMs;
  return Math.min(input.configuredIdleTimeoutMs, GOAT_FINISHED_TASK_SANDBOX_IDLE_TIMEOUT_MS);
}
