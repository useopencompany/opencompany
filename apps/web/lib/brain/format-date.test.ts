import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatBrainDate, formatRelativeBrainDate } from "./format-date";

const NOW = new Date("2026-06-01T12:00:00.000Z").getTime();

// Locale-independent expectation: reuse the same formatter the implementation
// uses, so the test stays correct regardless of the CI runtime locale.
function expectedRelative(seconds: number, unit: Intl.RelativeTimeFormatUnit) {
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(seconds, unit);
}

function atOffset(seconds: number): string {
  return new Date(NOW + seconds * 1000).toISOString();
}

describe("formatRelativeBrainDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'Unknown' for an unparseable date instead of an empty string", () => {
    expect(formatRelativeBrainDate("not-a-date")).toBe("Unknown");
    expect(formatRelativeBrainDate("")).toBe("Unknown");
  });

  it("uses the seconds bucket below 60s", () => {
    expect(formatRelativeBrainDate(atOffset(-30))).toBe(expectedRelative(-30, "second"));
    expect(formatRelativeBrainDate(atOffset(30))).toBe(expectedRelative(30, "second"));
  });

  it("uses the minutes bucket below 3600s", () => {
    expect(formatRelativeBrainDate(atOffset(-120))).toBe(expectedRelative(-2, "minute"));
    expect(formatRelativeBrainDate(atOffset(120))).toBe(expectedRelative(2, "minute"));
  });

  it("uses the hours bucket below 86400s", () => {
    expect(formatRelativeBrainDate(atOffset(-7200))).toBe(expectedRelative(-2, "hour"));
    expect(formatRelativeBrainDate(atOffset(7200))).toBe(expectedRelative(2, "hour"));
  });

  it("uses the days bucket below 2592000s", () => {
    expect(formatRelativeBrainDate(atOffset(-172800))).toBe(expectedRelative(-2, "day"));
    expect(formatRelativeBrainDate(atOffset(172800))).toBe(expectedRelative(2, "day"));
  });

  it("uses the months bucket below 31536000s", () => {
    expect(formatRelativeBrainDate(atOffset(-5184000))).toBe(expectedRelative(-2, "month"));
    expect(formatRelativeBrainDate(atOffset(5184000))).toBe(expectedRelative(2, "month"));
  });

  it("uses the years bucket at/above 31536000s", () => {
    expect(formatRelativeBrainDate(atOffset(-63072000))).toBe(expectedRelative(-2, "year"));
    expect(formatRelativeBrainDate(atOffset(63072000))).toBe(expectedRelative(2, "year"));
  });
});

describe("formatBrainDate", () => {
  it("returns 'Unknown' for an unparseable date", () => {
    expect(formatBrainDate("not-a-date")).toBe("Unknown");
  });

  it("formats a valid date to a non-empty label", () => {
    expect(formatBrainDate("2026-06-01T12:00:00.000Z").length).toBeGreaterThan(0);
  });
});
