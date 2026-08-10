import type {
  GoatTaskReportedOutcome,
  GoatTaskStage,
  GoatTaskStatus,
  GoatTaskViewMode,
} from "@opencompany/db/goat-schema";

export const GOAT_TASK_VIEW_MODES: GoatTaskViewMode[] = ["board", "list"];

export function isGoatTaskViewMode(value: unknown): value is GoatTaskViewMode {
  return GOAT_TASK_VIEW_MODES.some((mode) => mode === value);
}

export const GOAT_STAGE_COPY: Record<GoatTaskStage, string> = {
  queued: "Waiting for runner",
  planning: "Planning task",
  sandboxing: "Preparing task",
  running: "Running task",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

export const GOAT_STATUS_COPY: Record<GoatTaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  canceled: "Canceled",
};

export type GoatTaskBoardColumn = "in_progress" | "in_review" | "done" | "canceled";

export const GOAT_TASK_BOARD_COLUMNS: GoatTaskBoardColumn[] = [
  "in_progress",
  "in_review",
  "done",
  "canceled",
];

export const GOAT_TASK_BOARD_COLUMN_COPY: Record<GoatTaskBoardColumn, string> = {
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  canceled: "Canceled",
};

export function goatTaskBoardColumn(task: {
  status: GoatTaskStatus;
  reportedOutcome?: GoatTaskReportedOutcome | null;
}): GoatTaskBoardColumn {
  if (task.status === "queued" || task.status === "running") return "in_progress";
  if (task.status === "canceled") return "canceled";
  if (task.status === "failed" || task.reportedOutcome === "needs_attention") {
    return "in_review";
  }
  return "done";
}

// User-facing status for workflow tasks: the worker owns `status`; the agent's
// post-run report decides done vs needs-attention on top of a succeeded run.
export type GoatWorkflowTaskDisplayStatus =
  | "running"
  | "failed"
  | "done"
  | "canceled"
  | "needs-attention";

export const GOAT_WORKFLOW_TASK_STATUS_COPY: Record<GoatWorkflowTaskDisplayStatus, string> = {
  running: "Running",
  failed: "Failed",
  done: "Done",
  canceled: "Canceled",
  "needs-attention": "Needs attention",
};

export const GOAT_WORKFLOW_TASK_STATUS_DOT_CLASS: Record<GoatWorkflowTaskDisplayStatus, string> = {
  running: "bg-ink/40 animate-pulse",
  failed: "bg-danger",
  done: "bg-success",
  canceled: "bg-ink/30",
  "needs-attention": "bg-warning",
};

export function goatWorkflowTaskDisplayStatus(task: {
  status: GoatTaskStatus;
  reportedOutcome?: GoatTaskReportedOutcome | null;
}): GoatWorkflowTaskDisplayStatus {
  if (task.status === "queued" || task.status === "running") return "running";
  if (task.status === "failed") return "failed";
  if (task.status === "canceled") return "canceled";
  return task.reportedOutcome === "needs_attention" ? "needs-attention" : "done";
}

export function goatTaskBoardStatusCopy(task: {
  status: GoatTaskStatus;
  reportedOutcome?: GoatTaskReportedOutcome | null;
}): string {
  if (task.status === "succeeded" && task.reportedOutcome === "needs_attention") {
    return GOAT_WORKFLOW_TASK_STATUS_COPY["needs-attention"];
  }
  return GOAT_STATUS_COPY[task.status];
}

export function toGoatTaskTitle(text: string): string {
  const trimmed = text.trim().replace(/[.!]+$/, "");
  const clipped = trimmed.length > 64 ? `${trimmed.slice(0, 64).trimEnd()}...` : trimmed;
  return clipped.charAt(0).toUpperCase() + clipped.slice(1);
}

export function normalizeGoatTaskName(input: unknown, fallbackPrompt: string): string {
  if (typeof input === "string" && input.trim()) {
    return toGoatTaskName(input);
  }
  return toGoatTaskName(fallbackPrompt);
}

export function toGoatTaskName(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "Untitled task";
  const cleaned = firstLine
    .replace(/^(please\s+)?(can|could|would)\s+you\s+/i, "")
    .replace(/^(please\s+)?(help me|i need you to|i want you to)\s+/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 7).join(" ");
  const clipped = words.length > 48 ? `${words.slice(0, 48).trimEnd()}...` : words;
  const fallback = clipped || "Untitled task";
  return fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

export function formatGoatStartedAt(value: Date | string) {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatGoatTaskDuration(createdAt: Date | string, updatedAt: Date | string): string {
  const started =
    typeof createdAt === "string" ? new Date(createdAt).getTime() : createdAt.getTime();
  const finished =
    typeof updatedAt === "string" ? new Date(updatedAt).getTime() : updatedAt.getTime();
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return "—";
  return formatGoatTaskDurationMs(finished - started);
}

export function formatGoatTaskDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs)) return "—";
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
