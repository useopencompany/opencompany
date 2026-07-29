import { describe, expect, it } from "vitest";
import {
  formatGoatTaskDuration,
  formatGoatTaskDurationMs,
  goatTaskBoardColumn,
  goatWorkflowTaskDisplayStatus,
} from "@/lib/task-display";

describe("goatTaskBoardColumn", () => {
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
    expect(goatTaskBoardColumn({ status, reportedOutcome })).toBe(expected);
  });
});

describe("goatWorkflowTaskDisplayStatus", () => {
  it.each([
    ["queued", null, "running"],
    ["running", null, "running"],
    ["failed", null, "failed"],
    ["canceled", null, "canceled"],
    ["succeeded", null, "done"],
    ["succeeded", "done", "done"],
    ["succeeded", "needs_attention", "needs-attention"],
  ] as const)("maps %s with %s to %s", (status, reportedOutcome, expected) => {
    expect(goatWorkflowTaskDisplayStatus({ status, reportedOutcome })).toBe(expected);
  });
});

describe("formatGoatTaskDuration", () => {
  it("formats seconds, minutes, and hours", () => {
    const startedAt = "2026-07-29T09:00:00.000Z";

    expect(formatGoatTaskDuration(startedAt, "2026-07-29T09:00:12.999Z")).toBe("12s");
    expect(formatGoatTaskDuration(startedAt, "2026-07-29T09:03:12.000Z")).toBe("3m 12s");
    expect(formatGoatTaskDuration(startedAt, "2026-07-29T10:03:12.000Z")).toBe("1h 3m 12s");
  });

  it("clamps negative durations", () => {
    expect(formatGoatTaskDuration("2026-07-29T09:00:01.000Z", "2026-07-29T09:00:00.000Z")).toBe(
      "0s",
    );
  });
});

describe("formatGoatTaskDurationMs", () => {
  it("formats raw durations and rejects non-finite values", () => {
    expect(formatGoatTaskDurationMs(12_999)).toBe("12s");
    expect(formatGoatTaskDurationMs(192_000)).toBe("3m 12s");
    expect(formatGoatTaskDurationMs(3_792_000)).toBe("1h 3m 12s");
    expect(formatGoatTaskDurationMs(Number.NaN)).toBe("—");
  });
});
