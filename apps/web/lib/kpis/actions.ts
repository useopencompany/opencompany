"use server";

import { randomUUID } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { type KpiCardViz, kpiCards, kpiMetrics } from "@opencompany/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { currentWorkspace } from "@/lib/auth";
import { batchWithTxid } from "@/lib/db/txid";
import { kpiConfigHash } from "@/lib/kpis/config-hash";
import { getKpiCatalogEntry } from "@/lib/kpis/providers";
import { refreshKpiMetricNow } from "@/lib/kpis/refresh";
import { KPI_TIME_RANGES, type KpiTimeRangeDays } from "@/lib/kpis/types";

type KpiActionResult = { ok: true; txid: number } | { ok: false; error: string };

const KPI_CARD_VIZ: KpiCardViz[] = ["number", "bar", "line"];
const MAX_TITLE_LENGTH = 120;
// Manual refresh throttle: a click within this window is a cheerful no-op.
const MANUAL_REFRESH_MIN_INTERVAL_MS = 60 * 1000;

export async function createKpiCard(input: {
  provider: string;
  metricKey: string;
  title?: string;
  viz?: KpiCardViz;
  timeRangeDays?: number;
}): Promise<KpiActionResult> {
  const { user, workspace } = await currentWorkspace();

  const definition = getKpiCatalogEntry(input.provider, input.metricKey);
  if (!definition) return { ok: false, error: "Unknown KPI metric." };
  const { provider, entry } = definition;

  const viz = input.viz ?? entry.defaultViz;
  if (!KPI_CARD_VIZ.includes(viz)) return { ok: false, error: "Unknown card visualization." };
  const timeRangeDays = input.timeRangeDays ?? entry.defaultTimeRangeDays;
  if (!KPI_TIME_RANGES.includes(timeRangeDays as KpiTimeRangeDays)) {
    return { ok: false, error: "Unsupported time range." };
  }
  const title = (input.title ?? "").trim().slice(0, MAX_TITLE_LENGTH) || entry.label;

  const connection = await provider.getConnection(workspace.id);
  if (connection === null) {
    return {
      ok: false,
      error: `${provider.label} is not connected. Connect it in Settings first.`,
    };
  }

  let config: Record<string, unknown> = {};
  if (provider.resolveConfig) {
    try {
      config = await provider.resolveConfig(connection);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not configure the metric.",
      };
    }
  }
  const configHash = kpiConfigHash(config);

  const db = getDb();
  const now = new Date();

  // Find-or-create the metric: identical definitions share one row, so the
  // refresh sweep fetches once no matter how many cards display it.
  const [existing] = await db
    .select({ id: kpiMetrics.id })
    .from(kpiMetrics)
    .where(
      and(
        eq(kpiMetrics.workspaceId, workspace.id),
        eq(kpiMetrics.provider, provider.id),
        eq(kpiMetrics.metricKey, entry.key),
        eq(kpiMetrics.configHash, configHash),
      ),
    )
    .limit(1);

  let metricId = existing?.id ?? null;
  const isNewMetric = metricId === null;
  if (metricId === null) {
    metricId = `kpm_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db
      .insert(kpiMetrics)
      .values({
        id: metricId,
        workspaceId: workspace.id,
        provider: provider.id,
        metricKey: entry.key,
        config,
        configHash,
        metricType: entry.metricType,
        unit: entry.unit,
        label: entry.label,
        refreshIntervalMinutes: entry.refreshIntervalMinutes,
        nextRefreshAt: now,
        createdAt: now,
        updatedAt: now,
      })
      // A concurrent create of the same definition wins harmlessly.
      .onConflictDoNothing();
  }

  // First fetch inline so the new card renders with data, not a spinner until
  // the next cron tick. Best-effort: a failure lands as the metric's error
  // state, which the card surfaces.
  if (isNewMetric) {
    await refreshKpiMetricNow(
      {
        id: metricId,
        workspaceId: workspace.id,
        provider: provider.id,
        metricKey: entry.key,
        config,
        refreshIntervalMinutes: entry.refreshIntervalMinutes,
      },
      { connection },
    );
  }

  const txid = await batchWithTxid(
    db.insert(kpiCards).values({
      id: `kpc_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      workspaceId: workspace.id,
      metricId,
      title,
      viz,
      timeRangeDays,
      position: sql`COALESCE((SELECT MAX(${kpiCards.position}) + 1 FROM ${kpiCards} WHERE ${kpiCards.workspaceId} = ${workspace.id}), 0)`,
      createdByUserId: user.id,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return { ok: true, txid };
}

export async function updateKpiCard(
  cardId: string,
  patch: { title?: string; viz?: KpiCardViz; timeRangeDays?: number },
): Promise<KpiActionResult> {
  const { workspace } = await currentWorkspace();

  const set: Partial<typeof kpiCards.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) {
    const title = patch.title.trim().slice(0, MAX_TITLE_LENGTH);
    if (!title) return { ok: false, error: "Card title cannot be empty." };
    set.title = title;
  }
  if (patch.viz !== undefined) {
    if (!KPI_CARD_VIZ.includes(patch.viz))
      return { ok: false, error: "Unknown card visualization." };
    set.viz = patch.viz;
  }
  if (patch.timeRangeDays !== undefined) {
    if (!KPI_TIME_RANGES.includes(patch.timeRangeDays as KpiTimeRangeDays)) {
      return { ok: false, error: "Unsupported time range." };
    }
    set.timeRangeDays = patch.timeRangeDays;
  }

  const db = getDb();
  const txid = await batchWithTxid(
    db
      .update(kpiCards)
      .set(set)
      .where(and(eq(kpiCards.id, cardId), eq(kpiCards.workspaceId, workspace.id))),
  );
  return { ok: true, txid };
}

export async function deleteKpiCard(cardId: string): Promise<KpiActionResult> {
  const { workspace } = await currentWorkspace();
  const db = getDb();

  const [card] = await db
    .select({ metricId: kpiCards.metricId })
    .from(kpiCards)
    .where(and(eq(kpiCards.id, cardId), eq(kpiCards.workspaceId, workspace.id)))
    .limit(1);
  if (!card) return { ok: false, error: "Card not found." };

  // Same transaction: drop the card, then GC the metric if this was its last
  // card (the NOT EXISTS check sees the deletion). Datapoints cascade with the
  // metric — only metrics on the board ever get polled.
  const txid = await batchWithTxid(
    db.delete(kpiCards).where(and(eq(kpiCards.id, cardId), eq(kpiCards.workspaceId, workspace.id))),
    db
      .delete(kpiMetrics)
      .where(
        and(
          eq(kpiMetrics.id, card.metricId),
          eq(kpiMetrics.workspaceId, workspace.id),
          sql`NOT EXISTS (SELECT 1 FROM ${kpiCards} WHERE ${kpiCards.metricId} = ${card.metricId})`,
        ),
      ),
  );
  return { ok: true, txid };
}

export async function refreshKpiCard(
  cardId: string,
): Promise<{ ok: true; skipped?: boolean } | { ok: false; error: string }> {
  const { workspace } = await currentWorkspace();
  const db = getDb();

  const [row] = await db
    .select({
      metricId: kpiMetrics.id,
      provider: kpiMetrics.provider,
      metricKey: kpiMetrics.metricKey,
      config: kpiMetrics.config,
      refreshIntervalMinutes: kpiMetrics.refreshIntervalMinutes,
      lastRefreshedAt: kpiMetrics.lastRefreshedAt,
    })
    .from(kpiCards)
    .innerJoin(kpiMetrics, eq(kpiMetrics.id, kpiCards.metricId))
    .where(and(eq(kpiCards.id, cardId), eq(kpiCards.workspaceId, workspace.id)))
    .limit(1);
  if (!row) return { ok: false, error: "Card not found." };

  if (
    row.lastRefreshedAt &&
    Date.now() - row.lastRefreshedAt.getTime() < MANUAL_REFRESH_MIN_INTERVAL_MS
  ) {
    return { ok: true, skipped: true };
  }

  const result = await refreshKpiMetricNow({
    id: row.metricId,
    workspaceId: workspace.id,
    provider: row.provider,
    metricKey: row.metricKey,
    config: row.config,
    refreshIntervalMinutes: row.refreshIntervalMinutes,
  });
  return result.ok ? { ok: true } : result;
}
