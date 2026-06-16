import { getDb } from "@opencompany/db/client";
import { kpiCards, kpiDatapoints, kpiMetrics } from "@opencompany/db/schema";
import { eq } from "drizzle-orm";
import KpisView from "@/components/kpis/KpisView";
import { currentWorkspace } from "@/lib/auth";
import type {
  KpiBoardPayload,
  KpiCardPayload,
  KpiProviderPayload,
  KpiSeriesByMetric,
} from "@/lib/kpis/payload";
import { sortKpiCards } from "@/lib/kpis/payload";
import { listKpiProviders } from "@/lib/kpis/providers";

export default async function KpisPage() {
  const context = await currentWorkspace();
  const workspaceId = context.workspace.id;
  const db = getDb();

  const [cardRows, datapointRows, providers] = await Promise.all([
    db
      .select({
        id: kpiCards.id,
        title: kpiCards.title,
        viz: kpiCards.viz,
        timeRangeDays: kpiCards.timeRangeDays,
        position: kpiCards.position,
        createdAt: kpiCards.createdAt,
        metricId: kpiMetrics.id,
        provider: kpiMetrics.provider,
        metricKey: kpiMetrics.metricKey,
        label: kpiMetrics.label,
        unit: kpiMetrics.unit,
        metricType: kpiMetrics.metricType,
        lastRefreshedAt: kpiMetrics.lastRefreshedAt,
        lastRefreshStatus: kpiMetrics.lastRefreshStatus,
        lastRefreshError: kpiMetrics.lastRefreshError,
      })
      .from(kpiCards)
      .innerJoin(kpiMetrics, eq(kpiMetrics.id, kpiCards.metricId))
      .where(eq(kpiCards.workspaceId, workspaceId)),
    db
      .select({
        metricId: kpiDatapoints.metricId,
        ts: kpiDatapoints.ts,
        value: kpiDatapoints.value,
      })
      .from(kpiDatapoints)
      .where(eq(kpiDatapoints.workspaceId, workspaceId)),
    // Connection status drives the add-card picker (connected providers are
    // selectable; the rest deep-link to Settings).
    Promise.all(
      listKpiProviders().map(async (provider): Promise<KpiProviderPayload> => {
        let connected = false;
        try {
          connected = (await provider.getConnection(workspaceId)) !== null;
        } catch {
          connected = false;
        }
        return { id: provider.id, label: provider.label, connected, catalog: provider.catalog };
      }),
    ),
  ]);

  const cards: KpiCardPayload[] = sortKpiCards(
    cardRows.map((row) => ({
      id: row.id,
      title: row.title,
      viz: row.viz,
      timeRangeDays: row.timeRangeDays,
      position: row.position,
      createdAt: row.createdAt.toISOString(),
      metric: {
        id: row.metricId,
        provider: row.provider,
        metricKey: row.metricKey,
        label: row.label,
        unit: row.unit,
        metricType: row.metricType,
        lastRefreshedAt: row.lastRefreshedAt?.toISOString() ?? null,
        lastRefreshStatus: row.lastRefreshStatus,
        lastRefreshError: row.lastRefreshError,
      },
    })),
  );

  const series: KpiSeriesByMetric = {};
  for (const row of datapointRows) {
    (series[row.metricId] ??= []).push({ ts: row.ts.getTime(), value: row.value });
  }
  for (const points of Object.values(series)) points.sort((a, b) => a.ts - b.ts);

  const board: KpiBoardPayload = { cards, series };
  return <KpisView initialBoard={board} providers={providers} />;
}
