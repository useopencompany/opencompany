import { describe, expect, it } from "vitest";
import { type KpiSeriesPoint, summarizeKpi } from "@/lib/kpis/summarize";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// Fixed "now": 2026-06-12T15:00:00Z (mid-day so partial-day buckets are exercised).
const NOW = Date.UTC(2026, 5, 12, 15);

function daysAgo(days: number, atHour = 0): number {
  return Date.UTC(2026, 5, 12 - days, atHour);
}

describe("summarizeKpi", () => {
  it("returns an empty summary when there are no datapoints", () => {
    expect(summarizeKpi({ metricType: "current", points: [], rangeDays: 7, now: NOW })).toEqual({
      headline: null,
      delta: null,
      series: [],
    });
  });

  describe("current metrics (snapshots)", () => {
    it("uses the latest snapshot as headline and deltas against the window start", () => {
      const points: KpiSeriesPoint[] = [
        { ts: daysAgo(10), value: 4 },
        { ts: daysAgo(8), value: 5 }, // latest snapshot before the 7d window starts
        { ts: daysAgo(3), value: 9 },
        { ts: daysAgo(0, 14), value: 12 },
      ];
      const summary = summarizeKpi({ metricType: "current", points, rangeDays: 7, now: NOW });
      expect(summary.headline).toBe(12);
      expect(summary.delta).toEqual({ absolute: 7, percent: 140, direction: "up" });
      // Series only charts the window.
      expect(summary.series.map((point) => point.value)).toEqual([9, 12]);
    });

    it("falls back to the oldest snapshot when history is shorter than the window", () => {
      const points: KpiSeriesPoint[] = [
        { ts: daysAgo(2), value: 10 },
        { ts: daysAgo(0, 14), value: 8 },
      ];
      const summary = summarizeKpi({ metricType: "current", points, rangeDays: 30, now: NOW });
      expect(summary.headline).toBe(8);
      expect(summary.delta).toEqual({ absolute: -2, percent: -20, direction: "down" });
    });

    it("has no delta with a single snapshot", () => {
      const summary = summarizeKpi({
        metricType: "current",
        points: [{ ts: daysAgo(0, 14), value: 3 }],
        rangeDays: 7,
        now: NOW,
      });
      expect(summary.headline).toBe(3);
      expect(summary.delta).toBeNull();
      expect(summary.series).toHaveLength(1);
    });

    it("downsamples multi-day windows to one point per day", () => {
      const points: KpiSeriesPoint[] = [
        { ts: daysAgo(1, 9), value: 5 },
        { ts: daysAgo(1, 17), value: 6 }, // same day: last one wins
        { ts: daysAgo(0, 14), value: 7 },
      ];
      const summary = summarizeKpi({ metricType: "current", points, rangeDays: 7, now: NOW });
      expect(summary.series).toEqual([
        { ts: daysAgo(1, 17), value: 6 },
        { ts: daysAgo(0, 14), value: 7 },
      ]);
    });

    it("keeps hourly resolution for a 1-day window", () => {
      const points: KpiSeriesPoint[] = [
        { ts: NOW - 5 * HOUR_MS, value: 1 },
        { ts: NOW - 2 * HOUR_MS, value: 2 },
      ];
      const summary = summarizeKpi({ metricType: "current", points, rangeDays: 1, now: NOW });
      expect(summary.series).toHaveLength(2);
    });
  });

  describe("event metrics (day-bucketed counts)", () => {
    it("sums the trailing window and compares the previous window", () => {
      const points: KpiSeriesPoint[] = [
        { ts: daysAgo(10), value: 2 }, // previous window
        { ts: daysAgo(8), value: 3 }, // previous window
        { ts: daysAgo(5), value: 4 },
        { ts: daysAgo(0), value: 1 }, // today
      ];
      const summary = summarizeKpi({ metricType: "event", points, rangeDays: 7, now: NOW });
      expect(summary.headline).toBe(5);
      expect(summary.delta).toEqual({ absolute: 0, percent: 0, direction: "flat" });
    });

    it("zero-fills quiet days in the series", () => {
      const points: KpiSeriesPoint[] = [{ ts: daysAgo(2), value: 4 }];
      const summary = summarizeKpi({ metricType: "event", points, rangeDays: 7, now: NOW });
      expect(summary.series).toHaveLength(7);
      expect(summary.series.filter((point) => point.value === 0)).toHaveLength(6);
    });

    it("treats a 1-day range as today only", () => {
      const points: KpiSeriesPoint[] = [
        { ts: daysAgo(1), value: 9 },
        { ts: daysAgo(0), value: 2 },
      ];
      const summary = summarizeKpi({ metricType: "event", points, rangeDays: 1, now: NOW });
      expect(summary.headline).toBe(2);
      expect(summary.delta).toEqual({ absolute: -7, percent: (-7 / 9) * 100, direction: "down" });
    });

    it("omits the delta when there is no history before the window", () => {
      const points: KpiSeriesPoint[] = [{ ts: daysAgo(2), value: 4 }];
      const summary = summarizeKpi({ metricType: "event", points, rangeDays: 7, now: NOW });
      expect(summary.delta).toBeNull();
    });

    it("reports a null percent when the previous window sums to zero", () => {
      const points: KpiSeriesPoint[] = [
        { ts: daysAgo(10), value: 0 },
        { ts: daysAgo(3), value: 5 },
      ];
      const summary = summarizeKpi({ metricType: "event", points, rangeDays: 7, now: NOW });
      expect(summary.delta).toEqual({ absolute: 5, percent: null, direction: "up" });
    });
  });

  describe("bucketed metrics (provider-computed series)", () => {
    it("uses the latest bucket as headline and deltas one window back", () => {
      const points: KpiSeriesPoint[] = Array.from({ length: 40 }, (_, index) => ({
        ts: daysAgo(39 - index),
        value: 100 + index,
      }));
      const summary = summarizeKpi({ metricType: "bucketed", points, rangeDays: 30, now: NOW });
      expect(summary.headline).toBe(139); // today's bucket
      expect(summary.delta?.absolute).toBe(30); // vs bucket 30 days earlier
      expect(summary.delta?.direction).toBe("up");
      expect(summary.series).toHaveLength(30);
    });

    it("compares against the nearest earlier bucket when history is sparse", () => {
      const points: KpiSeriesPoint[] = [
        { ts: daysAgo(9), value: 50 },
        { ts: daysAgo(0), value: 60 },
      ];
      const summary = summarizeKpi({ metricType: "bucketed", points, rangeDays: 7, now: NOW });
      expect(summary.headline).toBe(60);
      expect(summary.delta).toEqual({ absolute: 10, percent: 20, direction: "up" });
    });

    it("has no delta when no bucket exists before the comparison point", () => {
      const points: KpiSeriesPoint[] = [
        { ts: daysAgo(3), value: 50 },
        { ts: daysAgo(0), value: 60 },
      ];
      const summary = summarizeKpi({ metricType: "bucketed", points, rangeDays: 7, now: NOW });
      expect(summary.delta).toBeNull();
    });

    it("ignores future buckets when picking the headline", () => {
      const points: KpiSeriesPoint[] = [
        { ts: daysAgo(1), value: 10 },
        { ts: NOW + DAY_MS, value: 99 },
      ];
      const summary = summarizeKpi({ metricType: "bucketed", points, rangeDays: 7, now: NOW });
      expect(summary.headline).toBe(10);
    });
  });
});
