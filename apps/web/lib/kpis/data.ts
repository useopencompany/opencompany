import { getDb } from "@opencompany/db/client";
import {
  type WorkspaceIntegration,
  type WorkspaceKpi,
  type WorkspaceKpiValue,
  workspaceIntegrations,
  workspaceKpis,
  workspaceKpiValues,
} from "@opencompany/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getKpiTemplate, KPI_TEMPLATE_CATALOG, parseKpiFilterParams } from "@/lib/kpis/templates";

const MAX_LIVE_FETCH_KPIS = 12;
const LIVE_FETCH_CONCURRENCY = 3;

export type KpiDataSource = Pick<
  WorkspaceIntegration,
  "id" | "workspaceId" | "provider" | "externalId" | "connectionLabel" | "accountName" | "metadata"
>;

export type KpiDashboardCard = {
  id: string;
  displayName: string;
  provider: string;
  templateId: string;
  templateName: string;
  description: string;
  timeGrain: "day" | "week";
  status: WorkspaceKpi["status"];
  statusReason: string | null;
  current: number | null;
  previous: number | null;
  liveError: string | null;
  points: Array<{ pointAt: string; value: number }>;
};

export type KpiDashboardState = {
  dataSources: KpiDataSource[];
  templates: Array<{
    id: string;
    displayName: string;
    description: string;
    provider: string;
    timeGrainOptions: Array<"day" | "week">;
    defaultTimeGrain: "day" | "week";
    filterParamsSchema: Array<{
      id: string;
      label: string;
      description?: string;
      type: "text";
      placeholder?: string;
      defaultValue?: string;
    }>;
  }>;
  cards: KpiDashboardCard[];
};

export async function loadKpiDashboardState(workspaceId: string): Promise<KpiDashboardState> {
  const db = getDb();
  const [dataSources, kpis] = await Promise.all([
    loadPostHogDataSources(workspaceId),
    db
      .select()
      .from(workspaceKpis)
      .where(eq(workspaceKpis.workspaceId, workspaceId))
      .orderBy(workspaceKpis.createdAt),
  ]);

  const pointsByKpi = await loadRecentKpiValues(
    workspaceId,
    kpis.map((kpi) => kpi.id),
  );
  const integrationById = new Map(dataSources.map((source) => [source.id, source]));
  const liveByKpi = new Map<
    string,
    { current: number | null; previous: number | null; error: string | null }
  >();

  await mapLimit(kpis.slice(0, MAX_LIVE_FETCH_KPIS), LIVE_FETCH_CONCURRENCY, async (kpi) => {
    const template = getKpiTemplate(kpi.provider, kpi.templateId);
    const integration = integrationById.get(kpi.sourceIntegrationId);
    if (!template || !integration || kpi.status === "disabled") {
      liveByKpi.set(kpi.id, { current: null, previous: null, error: null });
      return;
    }
    try {
      const result = await template.liveFetch({
        integration,
        timeGrain: kpi.timeGrain,
        filterParams: parseKpiFilterParams(kpi.filterParams),
      });
      liveByKpi.set(kpi.id, {
        current: result.current,
        previous: result.previous ?? null,
        error: null,
      });
    } catch (error) {
      liveByKpi.set(kpi.id, {
        current: null,
        previous: null,
        error: error instanceof Error ? error.message : "Live fetch failed.",
      });
    }
  });

  return {
    dataSources,
    templates: posthogTemplates(),
    cards: kpis.map((kpi) => {
      const template = getKpiTemplate(kpi.provider, kpi.templateId);
      const live = liveByKpi.get(kpi.id) ?? {
        current: null,
        previous: null,
        error:
          kpis.indexOf(kpi) >= MAX_LIVE_FETCH_KPIS ? "Live fetch skipped for this render." : null,
      };
      return {
        id: kpi.id,
        displayName: kpi.displayName,
        provider: kpi.provider,
        templateId: kpi.templateId,
        templateName: template?.displayName ?? kpi.templateId,
        description: template?.description ?? "",
        timeGrain: kpi.timeGrain,
        status: kpi.status,
        statusReason: kpi.statusReason,
        current: live.current,
        previous: live.previous,
        liveError: live.error,
        points: (pointsByKpi.get(kpi.id) ?? [])
          .slice()
          .reverse()
          .map((point) => ({
            pointAt: point.pointAt.toISOString(),
            value: numericValue(point.value),
          })),
      };
    }),
  };
}

export async function loadPostHogDataSources(workspaceId: string): Promise<KpiDataSource[]> {
  return getDb()
    .select({
      id: workspaceIntegrations.id,
      workspaceId: workspaceIntegrations.workspaceId,
      provider: workspaceIntegrations.provider,
      externalId: workspaceIntegrations.externalId,
      connectionLabel: workspaceIntegrations.connectionLabel,
      accountName: workspaceIntegrations.accountName,
      metadata: workspaceIntegrations.metadata,
    })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.provider, "posthog"),
        eq(workspaceIntegrations.providerKind, "data_source"),
        eq(workspaceIntegrations.status, "connected"),
      ),
    )
    .orderBy(workspaceIntegrations.connectionLabel, workspaceIntegrations.createdAt);
}

async function loadRecentKpiValues(workspaceId: string, kpiIds: string[]) {
  if (kpiIds.length === 0) return new Map<string, WorkspaceKpiValue[]>();
  const rows = await getDb()
    .select({
      id: workspaceKpiValues.id,
      kpiId: workspaceKpiValues.kpiId,
      pointAt: workspaceKpiValues.pointAt,
      value: workspaceKpiValues.value,
      grain: workspaceKpiValues.grain,
      fetchedAt: workspaceKpiValues.fetchedAt,
      source: workspaceKpiValues.source,
    })
    .from(workspaceKpiValues)
    .innerJoin(workspaceKpis, eq(workspaceKpis.id, workspaceKpiValues.kpiId))
    .where(
      and(eq(workspaceKpis.workspaceId, workspaceId), inArray(workspaceKpiValues.kpiId, kpiIds)),
    )
    .orderBy(desc(workspaceKpiValues.pointAt));

  const pointsByKpi = new Map<string, WorkspaceKpiValue[]>();
  for (const row of rows) {
    const existing = pointsByKpi.get(row.kpiId) ?? [];
    if (existing.length < 14) {
      existing.push(row);
      pointsByKpi.set(row.kpiId, existing);
    }
  }
  return pointsByKpi;
}

function posthogTemplates() {
  const templates = Object.values(KPI_TEMPLATE_CATALOG.posthog);
  return templates.map((template) => ({
    id: template.id,
    displayName: template.displayName,
    description: template.description,
    provider: template.provider,
    timeGrainOptions: template.timeGrainOptions,
    defaultTimeGrain: template.defaultTimeGrain,
    filterParamsSchema: template.filterParamsSchema,
  }));
}

async function mapLimit<T>(values: T[], limit: number, worker: (value: T) => Promise<void>) {
  const executing = new Set<Promise<void>>();
  for (const value of values) {
    const promise = worker(value).finally(() => executing.delete(promise));
    executing.add(promise);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
}

function numericValue(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
