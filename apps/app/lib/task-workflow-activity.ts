import type { HarnessEngine, TaskReportedOutcome, TaskStatus } from "@opencompany/db/schema";

export type TaskWorkflowStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "needs_attention"
  | "failed"
  | "canceled";

export type TaskWorkflowStepView = {
  id: string;
  index: number;
  total: number;
  title: string;
  engine: HarnessEngine;
  status: TaskWorkflowStepStatus;
};

export function deriveTaskWorkflowSteps(input: {
  harnessSpec: unknown;
  taskStatus: TaskStatus;
}): TaskWorkflowStepView[] {
  const workflow = readRecord(readRecord(input.harnessSpec)?.workflow);
  const rawSteps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  if (rawSteps.length <= 1) return [];

  const currentStepIndex = readCheckpoint(workflow?.currentStepIndex, 0, rawSteps.length - 1, 0);
  const completedStepCount = readCheckpoint(
    workflow?.completedStepCount,
    0,
    rawSteps.length,
    currentStepIndex,
  );
  const lastOutcome = readLastStepOutcome(workflow?.lastCompletedStepOutcome);

  return rawSteps.flatMap((rawStep, fallbackIndex) => {
    const step = readRecord(rawStep);
    if (!step) return [];
    const index = readCheckpoint(step.index, 0, rawSteps.length - 1, fallbackIndex);
    const title = readString(step.title).trim() || `Step ${index + 1}`;
    return [
      {
        id: `${index}:${title}`,
        index,
        total: rawSteps.length,
        title,
        engine: readEngine(step.engine),
        status: workflowStepStatus({
          index,
          currentStepIndex,
          completedStepCount,
          taskStatus: input.taskStatus,
          lastOutcome,
        }),
      },
    ];
  });
}

function workflowStepStatus(input: {
  index: number;
  currentStepIndex: number;
  completedStepCount: number;
  taskStatus: TaskStatus;
  lastOutcome: TaskReportedOutcome | null;
}): TaskWorkflowStepStatus {
  const lastCompletedIndex = input.completedStepCount - 1;
  if (input.index < input.completedStepCount) {
    if (input.index === lastCompletedIndex && input.lastOutcome === "needs_attention") {
      return "needs_attention";
    }
    return "completed";
  }
  if (input.index === input.currentStepIndex) {
    if (input.taskStatus === "failed") return "failed";
    if (input.taskStatus === "canceled") return "canceled";
    if (input.taskStatus === "queued") return "pending";
    return "running";
  }
  return "pending";
}

function readLastStepOutcome(value: unknown): TaskReportedOutcome | null {
  const outcome = readRecord(value)?.reportedOutcome;
  return outcome === "done" || outcome === "needs_attention" ? outcome : null;
}

function readCheckpoint(value: unknown, min: number, max: number, fallback: number) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value as number));
}

function readEngine(value: unknown): HarnessEngine {
  return value === "codex" || value === "claude_code" ? value : "opencompany";
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : "";
}
