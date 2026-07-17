import { BENCHMARK_TASKS as TOOL_EXPOSURE_TASKS } from "../tool-exposure/tasks";
import type { BenchmarkTask } from "./types";

// Import and adapt the exact corpus used by the parallel flat/tiered DAG spike.
// Result files can therefore be joined directly on task id without prompt drift.
export const BENCHMARK_TASKS: BenchmarkTask[] = TOOL_EXPOSURE_TASKS.map((task) => ({
  id: task.id,
  title: task.notes,
  prompt: task.prompt,
  minToolCalls: task.expectedTools.length,
  requiredTools: task.expectedTools.map(
    (pointer) => `${pointer.integrationId}.${pointer.toolName}`,
  ),
}));

// Kept outside the shared main corpus so the direct LCM/DAG comparison stays exact.
export const FAULT_INJECTION_TASKS: BenchmarkTask[] = [
  {
    id: "fault-recover-tool-error",
    title: "Recover from a deterministic integration rejection.",
    prompt:
      "Inspect GitHub pull request #91 in opencompany/goat and attempt to squash-merge it. The mock merge will be rejected. Catch that tool error and send its exact rejection reason to Slack #eng-release.",
    minToolCalls: 3,
    requiredTools: ["github.get_pull_request", "github.merge_pull_request", "slack.send_message"],
  },
];

export const ALL_EXPERIMENT_TASKS = [...BENCHMARK_TASKS, ...FAULT_INJECTION_TASKS];
