import { getDb } from "@opencompany/db/client";
import { type KpiMetric, kpiCards, kpiDatapoints, kpiMetrics } from "@opencompany/db/schema";
import { and, eq, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { type AnyKpiProvider, getKpiCatalogEntry } from "@/lib/kpis/providers";
import { KPI_FETCH_WINDOW_DAYS, type KpiDatapointValue } from "@/lib/kpis/types";

/**
 * The refresh engine: fetch a metric's datapoints from its provider and
 * snapshot them. Shared by the cron sweep, card creation (inline first fetch),
 * and the manual "refresh now" action.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// A claim older than this is from a crashed run and may be re-claimed.
const STALE_CLAIM_MS = 10 * 60 * 1000;
// When a metric's catalog entry disappears (provider removed/renamed), retry
// slowly instead of hot-looping on a permanent failure.
const MISSING_DEFINITION_RETRY_MINUTES = 60;

export type KpiRefreshResult = { ok: true } | { ok: false; error: string };

type RefreshableMetric = Pick<
  KpiMetric,
  "id" | "workspaceId" | "provider" | "metricKey" | "config" | "refreshIntervalMinutes"
>;

/**
 * Refreshes one metric immediately: resolve provider + connection, fetch the
 * full window, upsert datapoints, and record bookkeeping (ok or error). Never
 * throws — a failed refresh is a state on the metric, not an exception.
 *
 * Pass `connection` to reuse one already resolved for this workspace+provider
 * (the sweep batches that way so five cards on one connection cost one lookup).
 */
export async function refreshKpiMetricNow(
  metric: RefreshableMetric,
  options?: { connection?: unknown; now?: Date },
): Promise<KpiRefreshResult> {
  const now = options?.now ?? new Date();
  const definition = getKpiCatalogEntry(metric.provider, metric.metricKey);
  if (!definition) {
    return recordFailure(
      metric,
      `Unknown KPI metric "${metric.provider}/${metric.metricKey}".`,
      now,
      MISSING_DEFINITION_RETRY_MINUTES,
    );
  }
  const { provider, entry } = definition;

  try {
    const connection = options?.connection ?? (await provider.getConnection(metric.workspaceId));
    if (connection === null || connection === undefined) {
      return recordFailure(metric, `${provider.label} is not connected.`, now);
    }

    const range = {
      start: new Date(now.getTime() - KPI_FETCH_WINDOW_DAYS * DAY_MS),
      end: now,
    };
    const points = await provider.fetchMetric({
      connection,
      entry,
      config: metric.config,
      range,
    });
    await storeDatapoints(metric, sanitizePoints(points), now);
    return { ok: true };
  } catch (error) {
    return recordFailure(metric, error instanceof Error ? error.message : String(error), now);
  }
}

/**
 * Cron sweep: claim every due metric (claim = flip to "refreshing" so
 * overlapping runs never double-fetch; stale claims from crashed runs are
 * reclaimed after a timeout), refresh each with a per-(workspace, provider)
 * connection cache, and GC orphaned metrics. Per-metric failures isolate —
 * one bad provider never blocks the sweep.
 */
export async function sweepDueKpiMetrics(now = new Date()): Promise<{
  refreshed: number;
  failed: number;
  orphansDeleted: number;
}> {
  const db = getDb();
  const due = await db
    .update(kpiMetrics)
    .set({ lastRefreshStatus: "refreshing", updatedAt: now })
    .where(
      and(
        lte(kpiMetrics.nextRefreshAt, now),
        or(
          isNull(kpiMetrics.lastRefreshStatus),
          ne(kpiMetrics.lastRefreshStatus, "refreshing"),
          lt(kpiMetrics.updatedAt, new Date(now.getTime() - STALE_CLAIM_MS)),
        ),
      ),
    )
    .returning({
      id: kpiMetrics.id,
      workspaceId: kpiMetrics.workspaceId,
      provider: kpiMetrics.provider,
      metricKey: kpiMetrics.metricKey,
      config: kpiMetrics.config,
      refreshIntervalMinutes: kpiMetrics.refreshIntervalMinutes,
    });

  let refreshed = 0;
  let failed = 0;
  const connections = new Map<string, unknown>();
  for (const metric of due) {
    const connection = await resolveConnectionCached(connections, metric);
    const result = await refreshKpiMetricNow(metric, { connection, now: new Date() });
    if (result.ok) {
      refreshed += 1;
    } else {
      failed += 1;
    }
  }

  // Card deletion removes orphaned metrics inline; this backstop catches rows
  // stranded by a failed create (metric inserted, card insert never landed).
  const orphans = await db
    .delete(kpiMetrics)
    .where(
      and(
        lt(kpiMetrics.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
        sql`NOT EXISTS (SELECT 1 FROM ${kpiCards} WHERE ${kpiCards.metricId} = ${kpiMetrics.id})`,
      ),
    )
    .returning({ id: kpiMetrics.id });

  return { refreshed, failed, orphansDeleted: orphans.length };
}

async function resolveConnectionCached(
  cache: Map<string, unknown>,
  metric: Pick<RefreshableMetric, "workspaceId" | "provider" | "metricKey">,
): Promise<unknown> {
  const definition = getKpiCatalogEntry(metric.provider, metric.metricKey);
  if (!definition) return undefined; // refreshKpiMetricNow records the failure
  const cacheKey = `${metric.workspaceId}:${metric.provider}`;
  if (!cache.has(cacheKey)) {
    cache.set(cacheKey, await safeGetConnection(definition.provider, metric.workspaceId));
  }
  return cache.get(cacheKey);
}

async function safeGetConnection(provider: AnyKpiProvider, workspaceId: string) {
  try {
    return await provider.getConnection(workspaceId);
  } catch {
    return null; // surfaces as "not connected" on each metric
  }
}

async function storeDatapoints(metric: RefreshableMetric, points: KpiDatapointValue[], now: Date) {
  const db = getDb();
  const bookkeeping = db
    .update(kpiMetrics)
    .set({
      lastRefreshedAt: now,
      lastRefreshStatus: "ok",
      lastRefreshError: null,
      nextRefreshAt: nextRefreshAt(metric, now),
      updatedAt: now,
    })
    .where(eq(kpiMetrics.id, metric.id));

  if (points.length === 0) {
    await bookkeeping;
    return;
  }

  // One statement, idempotent on (metric, ts): refreshes rewrite buckets they
  // re-fetch and append new ones. Batched with the bookkeeping update so a
  // refresh is atomic.
  const upsert = db
    .insert(kpiDatapoints)
    .values(
      points.map((point) => ({
        workspaceId: metric.workspaceId,
        metricId: metric.id,
        ts: point.ts,
        value: point.value,
      })),
    )
    .onConflictDoUpdate({
      target: [kpiDatapoints.metricId, kpiDatapoints.ts],
      set: { value: sql`excluded.value` },
    });

  await db.batch([upsert, bookkeeping]);
}

async function recordFailure(
  metric: RefreshableMetric,
  message: string,
  now: Date,
  retryMinutes?: number,
): Promise<KpiRefreshResult> {
  const error = message.slice(0, 500);
  const db = getDb();
  await db
    .update(kpiMetrics)
    .set({
      lastRefreshStatus: "error",
      lastRefreshError: error,
      // Still advance the schedule so a failing metric retries on cadence
      // instead of hot-looping every sweep.
      nextRefreshAt: nextRefreshAt(metric, now, retryMinutes),
      updatedAt: now,
    })
    .where(eq(kpiMetrics.id, metric.id));
  return { ok: false, error };
}

function nextRefreshAt(metric: RefreshableMetric, now: Date, overrideMinutes?: number): Date {
  const minutes = overrideMinutes ?? Math.max(5, metric.refreshIntervalMinutes);
  return new Date(now.getTime() + minutes * 60 * 1000);
}

function sanitizePoints(points: KpiDatapointValue[]): KpiDatapointValue[] {
  return points.filter(
    (point) =>
      point.ts instanceof Date && !Number.isNaN(point.ts.getTime()) && Number.isFinite(point.value),
  );
}
