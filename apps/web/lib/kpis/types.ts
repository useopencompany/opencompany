import type { KpiCardViz, KpiMetricType } from "@opencompany/db/schema";

/**
 * The KPI provider contract — the seam that lets the dashboard scale to many
 * integrations. Everything downstream (refresh pipeline, cards, the add-card
 * picker) consumes only this interface: providers normalize on the RESPONSE
 * shape (uniform `{ts, value}` datapoints), never on the query shape, which
 * stays provider-internal.
 */

export type KpiDatapointValue = { ts: Date; value: number };

export type KpiFetchRange = { start: Date; end: Date };

export const KPI_TIME_RANGES = [1, 7, 30, 90] as const;
export type KpiTimeRangeDays = (typeof KPI_TIME_RANGES)[number];

export type KpiUnit = "count" | "users";

/**
 * A prebuilt metric users can place on the board. The catalog is the
 * click-together onboarding path: providers ship descriptors, the UI renders
 * a picker, no per-metric UI code.
 */
export type KpiCatalogEntry = {
  /** Globally unique, namespaced by provider: "github.open_prs". */
  key: string;
  label: string;
  description: string;
  metricType: KpiMetricType;
  unit: KpiUnit;
  defaultViz: KpiCardViz;
  defaultTimeRangeDays: KpiTimeRangeDays;
  /** Per-entry polling floor, keyed to the provider's rate budget. */
  refreshIntervalMinutes: number;
};

export type KpiProvider<TConnection = unknown> = {
  id: string;
  label: string;
  catalog: KpiCatalogEntry[];
  /** Resolves the workspace's auth/connection context, or null if not connected. */
  getConnection(workspaceId: string): Promise<TConnection | null>;
  /**
   * Optional one-time config resolution at metric creation (e.g. PostHog
   * project discovery). The result is persisted on the metric and passed back
   * to every fetch.
   */
  resolveConfig?(connection: TConnection): Promise<Record<string, unknown>>;
  /**
   * Fetches datapoints for the range. Bucketing is the provider's job:
   * `current` metrics return a single hour-truncated snapshot, `event` and
   * `bucketed` metrics return UTC day buckets (zero-filled across the range so
   * re-fetches heal stale buckets). Upserts on (metric, ts) make this idempotent.
   */
  fetchMetric(input: {
    connection: TConnection;
    entry: KpiCatalogEntry;
    config: Record<string, unknown>;
    range: KpiFetchRange;
  }): Promise<KpiDatapointValue[]>;
};

/** Widest window any card can display; every refresh fetches/heals this range. */
export const KPI_FETCH_WINDOW_DAYS = 90;

export function truncateToHourUtc(date: Date): Date {
  const truncated = new Date(date);
  truncated.setUTCMinutes(0, 0, 0);
  return truncated;
}

export function truncateToDayUtc(date: Date): Date {
  const truncated = new Date(date);
  truncated.setUTCHours(0, 0, 0, 0);
  return truncated;
}

/** Zero-filled UTC day buckets covering [start, end] — the event-metric base. */
export function emptyDayBuckets(range: KpiFetchRange): Map<number, KpiDatapointValue> {
  const buckets = new Map<number, KpiDatapointValue>();
  for (
    let day = truncateToDayUtc(range.start);
    day.getTime() <= range.end.getTime();
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000)
  ) {
    buckets.set(day.getTime(), { ts: new Date(day), value: 0 });
  }
  return buckets;
}
