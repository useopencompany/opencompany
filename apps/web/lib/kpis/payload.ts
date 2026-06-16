import type { KpiCardViz, KpiMetricRefreshStatus, KpiMetricType } from "@opencompany/db/schema";
import type { KpiCardRow, KpiDatapointRow, KpiMetricRow } from "@/lib/collections/types";
import type { KpiSeriesPoint } from "@/lib/kpis/summarize";
import type { KpiCatalogEntry } from "@/lib/kpis/types";

/**
 * Serializable shapes shared by the server page (initial render) and the
 * Electric live view (client). Both sides converge on these payloads so the
 * card components have exactly one input contract.
 */

export type KpiMetricPayload = {
  id: string;
  provider: string;
  metricKey: string;
  label: string;
  unit: string;
  metricType: KpiMetricType;
  lastRefreshedAt: string | null;
  lastRefreshStatus: KpiMetricRefreshStatus | null;
  lastRefreshError: string | null;
};

export type KpiCardPayload = {
  id: string;
  title: string;
  viz: KpiCardViz;
  timeRangeDays: number;
  position: number;
  createdAt: string;
  metric: KpiMetricPayload;
};

/** metricId → chronological series (epoch-ms timestamps, summarize-ready). */
export type KpiSeriesByMetric = Record<string, KpiSeriesPoint[]>;

export type KpiProviderPayload = {
  id: string;
  label: string;
  connected: boolean;
  catalog: KpiCatalogEntry[];
};

export type KpiBoardPayload = {
  cards: KpiCardPayload[];
  series: KpiSeriesByMetric;
};

export function kpiCardRowToPayload(
  row: KpiCardRow,
  metric: KpiMetricRow | undefined,
): KpiCardPayload | null {
  // A card can sync momentarily before its metric row arrives; skip until both
  // halves are present rather than rendering a half-empty card.
  if (!metric) return null;
  return {
    id: row.id,
    title: row.title,
    viz: row.viz,
    timeRangeDays: row.time_range_days,
    position: row.position,
    createdAt: row.created_at,
    metric: {
      id: metric.id,
      provider: metric.provider,
      metricKey: metric.metric_key,
      label: metric.label,
      unit: metric.unit,
      metricType: metric.metric_type,
      lastRefreshedAt: metric.last_refreshed_at,
      lastRefreshStatus: metric.last_refresh_status,
      lastRefreshError: metric.last_refresh_error,
    },
  };
}

export function kpiDatapointRowsToSeries(rows: KpiDatapointRow[]): KpiSeriesByMetric {
  const series: KpiSeriesByMetric = {};
  for (const row of rows) {
    const ts = Date.parse(row.ts);
    if (Number.isNaN(ts)) continue;
    (series[row.metric_id] ??= []).push({ ts, value: row.value });
  }
  for (const points of Object.values(series)) points.sort((a, b) => a.ts - b.ts);
  return series;
}

export function sortKpiCards(cards: KpiCardPayload[]): KpiCardPayload[] {
  return [...cards].sort(
    (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt),
  );
}
