import { describe, expect, it } from "vitest";
import { formatGoatDurationMs, taskTimestampMs } from "@/lib/task-display";

describe("formatGoatDurationMs", () => {
  it.each([
    [0, "0s"],
    [999, "0s"],
    [34_000, "34s"],
    [154_000, "2m 34s"],
    [3_600_000, "1h"],
    [4_320_000, "1h 12m"],
    [4_325_000, "1h 12m 5s"],
  ])("formats %i ms as %s", (durationMs, expected) => {
    expect(formatGoatDurationMs(durationMs)).toBe(expected);
  });

  it("clamps negative durations to zero", () => {
    expect(formatGoatDurationMs(-1_000)).toBe("0s");
  });
});

describe("taskTimestampMs", () => {
  it("returns null for missing or invalid values", () => {
    expect(taskTimestampMs(null)).toBeNull();
    expect(taskTimestampMs(undefined)).toBeNull();
    expect(taskTimestampMs("nope")).toBeNull();
  });

  it("parses Date and ISO timestamp values", () => {
    expect(taskTimestampMs(new Date("2026-01-01T00:00:00.000Z"))).toBe(1767225600000);
    expect(taskTimestampMs("2026-01-01T00:00:01.000Z")).toBe(1767225601000);
  });
});
