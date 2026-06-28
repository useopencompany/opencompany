import { getDb } from "@opencompany/db/client";
import {
  type WorkspaceIntegration,
  type WorkspaceKpi,
  type WorkspaceKpiTimeGrain,
  workspaceIntegrations,
  workspaceKpis,
  workspaceKpiValues,
} from "@opencompany/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { PostHogAuthenticationError } from "@/lib/kpis/posthog";
import { getKpiTemplate, parseKpiFilterParams } from "@/lib/kpis/templates";

export const KPI_EVALUATION_SWEEP_CRON = "15 2 * * *";

export type KpiEvaluationResult =
  | { status: "stored"; kpiId: string; pointAt: Date; value: number }
  | { status: "skipped"; kpiId: string; reason: string }
  | { status: "failed"; kpiId: string; reason: string };

export type KpiEvaluationRecord = Pick<
  WorkspaceKpi,
  "id" | "workspaceId" | "provider" | "templateId" | "timeGrain" | "filterParams" | "status"
>;

export type KpiEvaluationIntegration = Pick<
  WorkspaceIntegration,
  "id" | "workspaceId" | "provider" | "externalId" | "metadata"
>;

export async function evaluateKpi(input: {
  workspaceId: string;
  kpiId: string;
  now?: Date;
  fetchFn?: typeof fetch;
}): Promise<KpiEvaluationResult> {
  const db = getDb();
  const [row] = await db
    .select({ kpi: workspaceKpis, integration: workspaceIntegrations })
    .from(workspaceKpis)
    .innerJoin(
      workspaceIntegrations,
      and(
        eq(workspaceIntegrations.id, workspaceKpis.sourceIntegrationId),
        eq(workspaceIntegrations.workspaceId, workspaceKpis.workspaceId),
        eq(workspaceIntegrations.provider, workspaceKpis.provider),
      ),
    )
    .where(and(eq(workspaceKpis.workspaceId, input.workspaceId), eq(workspaceKpis.id, input.kpiId)))
    .limit(1);

  if (!row) return { status: "skipped", kpiId: input.kpiId, reason: "not_found" };

  return evaluateKpiWithDependencies({
    kpi: row.kpi,
    integration: row.integration,
    now: input.now ?? new Date(),
    ...fetchOption(input.fetchFn),
    upsertValue: async (value) => {
      const now = input.now ?? new Date();
      await db
        .insert(workspaceKpiValues)
        .values({
          id: newWorkspaceKpiValueId(),
          kpiId: value.kpiId,
          pointAt: value.pointAt,
          value: String(value.value),
          grain: value.grain,
          fetchedAt: now,
          source: value.source,
        })
        .onConflictDoUpdate({
          target: [workspaceKpiValues.kpiId, workspaceKpiValues.pointAt, workspaceKpiValues.grain],
          set: {
            value: String(value.value),
            fetchedAt: now,
            source: value.source,
          },
        });
    },
    markKpiStatus: async (status, statusReason) => {
      await db
        .update(workspaceKpis)
        .set({ status, statusReason, updatedAt: new Date() })
        .where(
          and(eq(workspaceKpis.workspaceId, row.kpi.workspaceId), eq(workspaceKpis.id, row.kpi.id)),
        );
    },
  });
}

export async function evaluateKpiWithDependencies(input: {
  kpi: KpiEvaluationRecord;
  integration: KpiEvaluationIntegration;
  now: Date;
  fetchFn?: typeof fetch;
  upsertValue: (value: {
    kpiId: string;
    pointAt: Date;
    value: number;
    grain: WorkspaceKpiTimeGrain;
    source: Record<string, unknown>;
  }) => Promise<void>;
  markKpiStatus: (status: "active" | "fetch_failed", statusReason: string | null) => Promise<void>;
}): Promise<KpiEvaluationResult> {
  if (input.kpi.status === "disabled") {
    return { status: "skipped", kpiId: input.kpi.id, reason: "disabled" };
  }

  const template = getKpiTemplate(input.kpi.provider, input.kpi.templateId);
  if (!template) {
    await input.markKpiStatus("fetch_failed", "KPI template is no longer available.");
    return { status: "failed", kpiId: input.kpi.id, reason: "template_missing" };
  }

  try {
    const window = evaluationWindow(input.kpi.timeGrain, input.now);
    const result = await template.liveFetch({
      integration: input.integration,
      timeGrain: input.kpi.timeGrain,
      filterParams: parseKpiFilterParams(input.kpi.filterParams),
      now: window.end,
      ...fetchOption(input.fetchFn),
    });
    await input.upsertValue({
      kpiId: input.kpi.id,
      pointAt: window.start,
      value: result.current,
      grain: input.kpi.timeGrain,
      source: {
        provider: input.kpi.provider,
        templateId: input.kpi.templateId,
        window: {
          start: window.start.toISOString(),
          end: window.end.toISOString(),
        },
        liveFetch: result.source ?? {},
      },
    });
    await input.markKpiStatus("active", null);
    return { status: "stored", kpiId: input.kpi.id, pointAt: window.start, value: result.current };
  } catch (error) {
    const reason =
      error instanceof PostHogAuthenticationError
        ? "PostHog connection needs reauthorization."
        : error instanceof Error
          ? error.message
          : "KPI evaluation failed.";
    await input.markKpiStatus("active", reason);
    return { status: "failed", kpiId: input.kpi.id, reason };
  }
}

export async function listDueKpis(input: { now?: Date; limit?: number }) {
  const now = input.now ?? new Date();
  const dueGrains: WorkspaceKpiTimeGrain[] = ["day"];
  if (isWeekBoundary(now)) dueGrains.push("week");

  return getDb()
    .select({ workspaceId: workspaceKpis.workspaceId, kpiId: workspaceKpis.id })
    .from(workspaceKpis)
    .where(
      and(
        inArray(workspaceKpis.status, ["active", "fetch_failed"]),
        inArray(workspaceKpis.timeGrain, dueGrains),
      ),
    )
    .orderBy(workspaceKpis.createdAt)
    .limit(input.limit ?? 100);
}

export async function evaluateDueKpis(input: { now?: Date; limit?: number } = {}) {
  const now = input.now ?? new Date();
  const kpis = await listDueKpis({ now, ...(input.limit ? { limit: input.limit } : {}) });
  let stored = 0;
  let failed = 0;
  for (const kpi of kpis) {
    const result = await evaluateKpi({ workspaceId: kpi.workspaceId, kpiId: kpi.kpiId, now });
    if (result.status === "stored") stored += 1;
    if (result.status === "failed") failed += 1;
  }
  return { scanned: kpis.length, stored, failed };
}

export function grainBoundary(grain: WorkspaceKpiTimeGrain, date: Date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (grain === "day") return day;
  const dayOfWeek = day.getUTCDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  return new Date(day.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
}

export function evaluationWindow(grain: WorkspaceKpiTimeGrain, date: Date) {
  const end = grainBoundary(grain, date);
  const durationMs = (grain === "week" ? 7 : 1) * 24 * 60 * 60 * 1000;
  return {
    start: new Date(end.getTime() - durationMs),
    end,
  };
}

function isWeekBoundary(date: Date) {
  return date.getUTCDay() === 1;
}

function newWorkspaceKpiValueId() {
  return `wkval_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function fetchOption(fetchFn: typeof fetch | undefined) {
  return fetchFn ? { fetchFn } : {};
}
