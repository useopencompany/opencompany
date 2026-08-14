import { describe, expect, it } from "vitest";
import {
  formatTaskDuration,
  formatTaskDurationMs,
  isTaskViewMode,
  taskBoardColumn,
  workflowTaskDisplayStatus,
} from "@/lib/task-display";

describe("taskBoardColumn", () => {
  it.each([
    ["queued", null, "in_progress"],
    ["queued", "done", "in_progress"],
    ["queued", "needs_attention", "in_progress"],
    ["running", null, "in_progress"],
    ["running", "done", "in_progress"],
    ["running", "needs_attention", "in_progress"],
    ["succeeded", null, "done"],
    ["succeeded", "done", "done"],
    ["succeeded", "needs_attention", "in_review"],
    ["failed", null, "in_review"],
    ["failed", "done", "in_review"],
    ["failed", "needs_attention", "in_review"],
    ["canceled", null, "canceled"],
    ["canceled", "done", "canceled"],
    ["canceled", "needs_attention", "canceled"],
  ] as const)("maps %s with %s to %s", (status, reportedOutcome, expected) => {
    expect(taskBoardColumn({ status, reportedOutcome })).toBe(expected);
  });
});

describe("workflowTaskDisplayStatus", () => {
  it.each([
    ["queued", null, "running"],
    ["running", null, "running"],
    ["failed", null, "failed"],
    ["canceled", null, "canceled"],
    ["succeeded", null, "done"],
    ["succeeded", "done", "done"],
    ["succeeded", "needs_attention", "needs-attention"],
  ] as const)("maps %s with %s to %s", (status, reportedOutcome, expected) => {
    expect(workflowTaskDisplayStatus({ status, reportedOutcome })).toBe(expected);
  });
});

describe("formatTaskDuration", () => {
  it("formats seconds, minutes, and hours", () => {
    const startedAt = "2026-07-29T09:00:00.000Z";

    expect(formatTaskDuration(startedAt, "2026-07-29T09:00:12.999Z")).toBe("12s");
    expect(formatTaskDuration(startedAt, "2026-07-29T09:03:12.000Z")).toBe("3m 12s");
    expect(formatTaskDuration(startedAt, "2026-07-29T10:03:12.000Z")).toBe("1h 3m 12s");
  });

  it("clamps negative durations", () => {
    expect(formatTaskDuration("2026-07-29T09:00:01.000Z", "2026-07-29T09:00:00.000Z")).toBe("0s");
  });
});

describe("formatTaskDurationMs", () => {
  it("formats raw durations and rejects non-finite values", () => {
    expect(formatTaskDurationMs(12_999)).toBe("12s");
    expect(formatTaskDurationMs(192_000)).toBe("3m 12s");
    expect(formatTaskDurationMs(3_792_000)).toBe("1h 3m 12s");
    expect(formatTaskDurationMs(Number.NaN)).toBe("—");
  });
});

describe("isTaskViewMode", () => {
  it("accepts only the known view modes", () => {
    expect(isTaskViewMode("board")).toBe(true);
    expect(isTaskViewMode("list")).toBe(true);
    expect(isTaskViewMode("kanban")).toBe(false);
    expect(isTaskViewMode(null)).toBe(false);
    expect(isTaskViewMode(undefined)).toBe(false);
  });
});
