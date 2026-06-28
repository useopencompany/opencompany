import type {
  WorkspaceIntegration,
  WorkspaceKpiTimeGrain,
  WorkspaceKpiValue,
} from "@opencompany/db/schema";
import {
  fetchPostHogDistinctUsers,
  fetchPostHogEventCount,
  POSTHOG_KPI_PROVIDER,
  parsePostHogEventNames,
} from "@/lib/kpis/posthog";

export type KpiProvider = typeof POSTHOG_KPI_PROVIDER;
export type KpiTemplateId = "posthog_dau" | "posthog_wau" | "posthog_signups";

export type KpiFilterField = {
  id: string;
  label: string;
  description?: string;
  type: "text";
  placeholder?: string;
  defaultValue?: string;
};

export type KpiFilterParams = {
  mode: "template";
  version: 1;
  values: Record<string, unknown>;
};

export type KpiLiveFetchResult = {
  current: number;
  previous?: number;
  source?: Record<string, unknown>;
};

export type KpiTemplate = {
  id: KpiTemplateId;
  provider: KpiProvider;
  displayName: string;
  description: string;
  timeGrainOptions: WorkspaceKpiTimeGrain[];
  defaultTimeGrain: WorkspaceKpiTimeGrain;
  filterParamsSchema: KpiFilterField[];
  compute: (points: Pick<WorkspaceKpiValue, "pointAt" | "value">[]) => number;
  liveFetch: (input: {
    integration: Pick<
      WorkspaceIntegration,
      "id" | "workspaceId" | "provider" | "externalId" | "metadata"
    >;
    timeGrain: WorkspaceKpiTimeGrain;
    filterParams: KpiFilterParams;
    now?: Date;
    fetchFn?: typeof fetch;
  }) => Promise<KpiLiveFetchResult>;
};

const SIGNUP_EVENT_FALLBACK = ["signup", "$identify"];

export const KPI_TEMPLATE_CATALOG: Record<KpiProvider, Record<KpiTemplateId, KpiTemplate>> = {
  posthog: {
    posthog_dau: {
      id: "posthog_dau",
      provider: "posthog",
      displayName: "Daily active users",
      description: "Distinct users with any event in the last 24 hours.",
      timeGrainOptions: ["day"],
      defaultTimeGrain: "day",
      filterParamsSchema: [],
      compute: computeLatestPoint,
      liveFetch: async ({ integration, now, fetchFn }) => {
        const current = activeWindow(now ?? new Date(), 1);
        const previous = previousWindow(current);
        const [currentResult, previousResult] = await Promise.all([
          fetchPostHogDistinctUsers({ integration, window: current, ...fetchOption(fetchFn) }),
          fetchPostHogDistinctUsers({ integration, window: previous, ...fetchOption(fetchFn) }),
        ]);
        return {
          current: currentResult.value,
          previous: previousResult.value,
          source: { current: currentResult.source, previous: previousResult.source },
        };
      },
    },
    posthog_wau: {
      id: "posthog_wau",
      provider: "posthog",
      displayName: "Weekly active users",
      description: "Distinct users with any event in the last 7 days.",
      timeGrainOptions: ["week"],
      defaultTimeGrain: "week",
      filterParamsSchema: [],
      compute: computeLatestPoint,
      liveFetch: async ({ integration, now, fetchFn }) => {
        const current = activeWindow(now ?? new Date(), 7);
        const previous = previousWindow(current);
        const [currentResult, previousResult] = await Promise.all([
          fetchPostHogDistinctUsers({ integration, window: current, ...fetchOption(fetchFn) }),
          fetchPostHogDistinctUsers({ integration, window: previous, ...fetchOption(fetchFn) }),
        ]);
        return {
          current: currentResult.value,
          previous: previousResult.value,
          source: { current: currentResult.source, previous: previousResult.source },
        };
      },
    },
    posthog_signups: {
      id: "posthog_signups",
      provider: "posthog",
      displayName: "Signups",
      description: "Signup and identify events in the selected window.",
      timeGrainOptions: ["day", "week"],
      defaultTimeGrain: "day",
      filterParamsSchema: [
        {
          id: "eventNames",
          label: "Event names",
          description: "Comma-separated PostHog event names.",
          type: "text",
          placeholder: "signup, $identify",
          defaultValue: SIGNUP_EVENT_FALLBACK.join(", "),
        },
      ],
      compute: computeLatestPoint,
      liveFetch: async ({ integration, timeGrain, filterParams, now, fetchFn }) => {
        const dayCount = timeGrain === "week" ? 7 : 1;
        const current = activeWindow(now ?? new Date(), dayCount);
        const previous = previousWindow(current);
        const eventNames = parsePostHogEventNames(
          filterParams.values.eventNames,
          SIGNUP_EVENT_FALLBACK,
        );
        const [currentResult, previousResult] = await Promise.all([
          fetchPostHogEventCount({
            integration,
            window: current,
            eventNames,
            ...fetchOption(fetchFn),
          }),
          fetchPostHogEventCount({
            integration,
            window: previous,
            eventNames,
            ...fetchOption(fetchFn),
          }),
        ]);
        return {
          current: currentResult.value,
          previous: previousResult.value,
          source: { current: currentResult.source, previous: previousResult.source, eventNames },
        };
      },
    },
  },
};

export function getKpiTemplate(provider: string, templateId: string): KpiTemplate | null {
  if (provider !== POSTHOG_KPI_PROVIDER) return null;
  return KPI_TEMPLATE_CATALOG.posthog[templateId as KpiTemplateId] ?? null;
}

export function normalizeKpiFilterParams(
  template: KpiTemplate,
  input: Record<string, unknown>,
): KpiFilterParams {
  const values: Record<string, unknown> = {};
  for (const field of template.filterParamsSchema) {
    const raw = input[field.id];
    if (typeof raw === "string" && raw.trim()) {
      values[field.id] = raw.trim();
    } else if (field.defaultValue) {
      values[field.id] = field.defaultValue;
    }
  }
  return { mode: "template", version: 1, values };
}

export function parseKpiFilterParams(value: Record<string, unknown>): KpiFilterParams {
  if (
    value.mode === "template" &&
    value.version === 1 &&
    value.values &&
    typeof value.values === "object" &&
    !Array.isArray(value.values)
  ) {
    return { mode: "template", version: 1, values: value.values as Record<string, unknown> };
  }
  return { mode: "template", version: 1, values: value };
}

function computeLatestPoint(points: Pick<WorkspaceKpiValue, "pointAt" | "value">[]) {
  const latest = [...points].sort(
    (left, right) => right.pointAt.getTime() - left.pointAt.getTime(),
  )[0];
  if (!latest) return 0;
  if (typeof latest.value === "number") return latest.value;
  const parsed = Number(latest.value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function activeWindow(now: Date, days: number) {
  const end = now;
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end };
}

function previousWindow(window: { start: Date; end: Date }) {
  const durationMs = window.end.getTime() - window.start.getTime();
  return {
    start: new Date(window.start.getTime() - durationMs),
    end: window.start,
  };
}

function fetchOption(fetchFn: typeof fetch | undefined) {
  return fetchFn ? { fetchFn } : {};
}
