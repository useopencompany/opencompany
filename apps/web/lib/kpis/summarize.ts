import type { KpiMetricType } from "@opencompany/db/schema";

/**
 * Pure presentation math: turns a metric's stored datapoints into what a card
 * renders — headline value, delta vs the previous equal-length period, and the
 * series to chart. Timestamps are epoch milliseconds so this stays runtime-
 * agnostic (Electric rows carry ISO strings, server rows carry Dates; callers
 * normalize).
 *
 * Window semantics by metric type:
 * - current: headline is the latest snapshot; delta compares against the
 *   snapshot nearest to the start of the window ("vs 7d ago").
 * - event: day buckets; headline is the sum over the trailing N calendar days
 *   (a 1-day range reads as "today"); delta compares the previous N days.
 * - bucketed: headline is the most recent bucket value; delta compares the
 *   bucket one window-length earlier.
 */

export type KpiSeriesPoint = { ts: number; value: number };

export type KpiDelta = {
  absolute: number;
  /** Null when the baseline is 0 (percent undefined). */
  percent: number | null;
  direction: "up" | "down" | "flat";
};

export type KpiSummary = {
  /** Null when the metric has no datapoints yet. */
  headline: number | null;
  /** Null when there is not enough history to compare. */
  delta: KpiDelta | null;
  series: KpiSeriesPoint[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function summarizeKpi(input: {
  metricType: KpiMetricType;
  /** Datapoints in any order; values at epoch-ms timestamps. */
  points: KpiSeriesPoint[];
  rangeDays: number;
  now: number;
}): KpiSummary {
  const points = [...input.points].sort((a, b) => a.ts - b.ts);
  if (points.length === 0) return { headline: null, delta: null, series: [] };

  switch (input.metricType) {
    case "current":
      return summarizeCurrent(points, input.rangeDays, input.now);
    case "event":
      return summarizeEvent(points, input.rangeDays, input.now);
    case "bucketed":
      return summarizeBucketed(points, input.rangeDays, input.now);
  }
}

function summarizeCurrent(points: KpiSeriesPoint[], rangeDays: number, now: number): KpiSummary {
  const windowStart = now - rangeDays * DAY_MS;
  const latest = points[points.length - 1] as KpiSeriesPoint;

  // Baseline: the snapshot in effect at the start of the window; with less
  // history than the window, fall back to the oldest snapshot we have.
  const atOrBeforeStart = [...points].reverse().find((point) => point.ts <= windowStart);
  const baseline = atOrBeforeStart ?? (points[0] !== latest ? points[0] : undefined);

  const inWindow = points.filter((point) => point.ts > windowStart);
  // Hour-bucketed snapshots get dense over long windows; charting one value
  // per day keeps long ranges readable (the latest snapshot of each day wins).
  const series = rangeDays > 1 ? lastPerDay(inWindow) : inWindow;

  return {
    headline: latest.value,
    delta: baseline ? computeDelta(latest.value, baseline.value) : null,
    series: series.length > 0 ? series : [latest],
  };
}

function summarizeEvent(points: KpiSeriesPoint[], rangeDays: number, now: number): KpiSummary {
  // Calendar windows: the current window is the trailing N days including
  // today's (partial) bucket; the previous window is the N days before that.
  const windowStart = dayStartUtc(now) - (rangeDays - 1) * DAY_MS;
  const previousStart = windowStart - rangeDays * DAY_MS;

  let current = 0;
  let previous = 0;
  const byDay = new Map<number, number>();
  for (const point of points) {
    if (point.ts >= windowStart) {
      current += point.value;
      byDay.set(dayStartUtc(point.ts), (byDay.get(dayStartUtc(point.ts)) ?? 0) + point.value);
    } else if (point.ts >= previousStart) {
      previous += point.value;
    }
  }

  // Zero-fill so bar charts show quiet days instead of collapsing them.
  const series: KpiSeriesPoint[] = [];
  for (let day = windowStart; day <= now; day += DAY_MS) {
    series.push({ ts: day, value: byDay.get(day) ?? 0 });
  }

  const hasPreviousWindowHistory = points.some((point) => point.ts < windowStart);
  return {
    headline: current,
    delta: hasPreviousWindowHistory ? computeDelta(current, previous) : null,
    series,
  };
}

function summarizeBucketed(points: KpiSeriesPoint[], rangeDays: number, now: number): KpiSummary {
  const upToNow = points.filter((point) => point.ts <= now);
  const latest = upToNow[upToNow.length - 1] ?? (points[0] as KpiSeriesPoint);

  // Baseline: the bucket one window-length before the latest bucket (nearest
  // at-or-before, so sparse history still compares sensibly).
  const baselineTs = latest.ts - rangeDays * DAY_MS;
  const baseline = [...points].reverse().find((point) => point.ts <= baselineTs);

  const windowStart = dayStartUtc(now) - (rangeDays - 1) * DAY_MS;
  const series = points.filter((point) => point.ts >= windowStart && point.ts <= now);

  return {
    headline: latest.value,
    delta: baseline ? computeDelta(latest.value, baseline.value) : null,
    series: series.length > 0 ? series : [latest],
  };
}

function computeDelta(currentValue: number, baselineValue: number): KpiDelta {
  const absolute = currentValue - baselineValue;
  return {
    absolute,
    percent: baselineValue === 0 ? null : (absolute / Math.abs(baselineValue)) * 100,
    direction: absolute > 0 ? "up" : absolute < 0 ? "down" : "flat",
  };
}

function lastPerDay(points: KpiSeriesPoint[]): KpiSeriesPoint[] {
  const byDay = new Map<number, KpiSeriesPoint>();
  for (const point of points) byDay.set(dayStartUtc(point.ts), point);
  return [...byDay.values()].sort((a, b) => a.ts - b.ts);
}

function dayStartUtc(ts: number): number {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}
