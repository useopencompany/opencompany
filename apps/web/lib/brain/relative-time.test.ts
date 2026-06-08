import { describe, expect, it } from "vitest";
import { formatBrainRelativeTime } from "./relative-time";

const DAY = 24 * 60 * 60;
const now = new Date("2026-06-08T12:00:00.000Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

describe("formatBrainRelativeTime", () => {
  it("shows 'just now' for very recent and future timestamps", () => {
    expect(formatBrainRelativeTime(ago(0), now)).toBe("just now");
    expect(formatBrainRelativeTime(ago(44), now)).toBe("just now");
    // Clock skew: a timestamp slightly in the future never reads as "in X".
    expect(formatBrainRelativeTime(ago(-30), now)).toBe("just now");
  });

  it("formats minutes with singular/plural thresholds", () => {
    expect(formatBrainRelativeTime(ago(60), now)).toBe("1 minute ago");
    expect(formatBrainRelativeTime(ago(5 * 60), now)).toBe("5 minutes ago");
    expect(formatBrainRelativeTime(ago(44 * 60), now)).toBe("44 minutes ago");
  });

  it("formats hours", () => {
    expect(formatBrainRelativeTime(ago(60 * 60), now)).toBe("1 hour ago");
    expect(formatBrainRelativeTime(ago(2 * 60 * 60), now)).toBe("2 hours ago");
    expect(formatBrainRelativeTime(ago(23 * 60 * 60), now)).toBe("23 hours ago");
  });

  it("formats days, months and years", () => {
    expect(formatBrainRelativeTime(ago(25 * 60 * 60), now)).toBe("1 day ago");
    expect(formatBrainRelativeTime(ago(3 * DAY), now)).toBe("3 days ago");
    expect(formatBrainRelativeTime(ago(40 * DAY), now)).toBe("1 month ago");
    expect(formatBrainRelativeTime(ago(95 * DAY), now)).toBe("3 months ago");
    expect(formatBrainRelativeTime(ago(400 * DAY), now)).toBe("1 year ago");
    expect(formatBrainRelativeTime(ago(900 * DAY), now)).toBe("2 years ago");
  });

  it("returns 'unknown' for an unparseable value", () => {
    expect(formatBrainRelativeTime("not-a-date", now)).toBe("unknown");
  });
});
