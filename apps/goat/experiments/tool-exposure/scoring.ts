import type { BenchmarkTask, ObservedToolCall, TaskScore } from "./types";

function key(integrationId: string, toolName: string): string {
  return `${integrationId}.${toolName}`;
}

export function scoreToolSelection(
  task: BenchmarkTask,
  observedToolCalls: readonly ObservedToolCall[],
): TaskScore {
  const expected = new Set(
    task.expectedTools.map((pointer) => key(pointer.integrationId, pointer.toolName)),
  );
  const observed = new Set(
    observedToolCalls
      .filter((call) => call.valid)
      .map((call) => key(call.integrationId, call.toolName)),
  );
  const missingTools = [...expected].filter((toolName) => !observed.has(toolName));
  const unexpectedTools = [...observed].filter((toolName) => !expected.has(toolName));
  const truePositives = [...observed].filter((toolName) => expected.has(toolName)).length;
  const observedIntegrations = new Set(
    observedToolCalls.filter((call) => call.valid).map((call) => call.integrationId),
  );
  const foundIntegrations = task.expectedIntegrationIds.filter((integrationId) =>
    observedIntegrations.has(integrationId),
  ).length;

  return {
    exact: missingTools.length === 0 && unexpectedTools.length === 0,
    precision: observed.size === 0 ? 0 : truePositives / observed.size,
    recall: expected.size === 0 ? 1 : truePositives / expected.size,
    integrationRecall:
      task.expectedIntegrationIds.length === 0
        ? 1
        : foundIntegrations / task.expectedIntegrationIds.length,
    missingTools,
    unexpectedTools,
  };
}
