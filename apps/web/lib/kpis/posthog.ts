import type { WorkspaceIntegration } from "@opencompany/db/schema";
import { loadIntegrationCredential } from "@/lib/integrations/credential-storage";

export const POSTHOG_KPI_PROVIDER = "posthog";
export const POSTHOG_KPI_CREDENTIAL_KIND = "oauth_token";
export const DEFAULT_POSTHOG_API_HOST = "https://us.posthog.com";

export type PostHogQueryResult = {
  results?: unknown[][];
  is_cached?: boolean;
  timings?: unknown;
};

export type PostHogMetricWindow = {
  start: Date;
  end: Date;
};

export type PostHogMetricFetchResult = {
  value: number;
  source: {
    endpoint: string;
    query: string;
    response: PostHogQueryResult;
    window: { start: string; end: string };
  };
};

export async function fetchPostHogDistinctUsers(input: {
  integration: Pick<
    WorkspaceIntegration,
    "id" | "workspaceId" | "provider" | "externalId" | "metadata"
  >;
  window: PostHogMetricWindow;
  fetchFn?: typeof fetch;
}): Promise<PostHogMetricFetchResult> {
  return fetchPostHogCount({
    integration: input.integration,
    window: input.window,
    query: `
      SELECT count(DISTINCT distinct_id)
      FROM events
      WHERE timestamp >= ${hogqlDate(input.window.start)}
        AND timestamp < ${hogqlDate(input.window.end)}
      LIMIT 1
    `,
    queryName: "opencompany_kpi_distinct_users",
    ...fetchOption(input.fetchFn),
  });
}

export async function fetchPostHogEventCount(input: {
  integration: Pick<
    WorkspaceIntegration,
    "id" | "workspaceId" | "provider" | "externalId" | "metadata"
  >;
  window: PostHogMetricWindow;
  eventNames: string[];
  fetchFn?: typeof fetch;
}): Promise<PostHogMetricFetchResult> {
  const names = input.eventNames.map(hogqlString).join(", ");
  return fetchPostHogCount({
    integration: input.integration,
    window: input.window,
    query: `
      SELECT count()
      FROM events
      WHERE timestamp >= ${hogqlDate(input.window.start)}
        AND timestamp < ${hogqlDate(input.window.end)}
        AND event IN (${names})
      LIMIT 1
    `,
    queryName: "opencompany_kpi_event_count",
    ...fetchOption(input.fetchFn),
  });
}

async function fetchPostHogCount(input: {
  integration: Pick<
    WorkspaceIntegration,
    "id" | "workspaceId" | "provider" | "externalId" | "metadata"
  >;
  window: PostHogMetricWindow;
  query: string;
  queryName: string;
  fetchFn?: typeof fetch;
}): Promise<PostHogMetricFetchResult> {
  const credential = await loadIntegrationCredential({
    workspaceId: input.integration.workspaceId,
    integrationId: input.integration.id,
    provider: POSTHOG_KPI_PROVIDER,
    kind: POSTHOG_KPI_CREDENTIAL_KIND,
  });
  const accessToken =
    typeof credential?.payload.accessToken === "string" ? credential.payload.accessToken : "";
  if (!accessToken) throw new Error("PostHog data-source credential is missing.");

  const apiHost = readPostHogApiHost(input.integration.metadata);
  const endpoint = `${apiHost}/api/projects/${encodeURIComponent(input.integration.externalId)}/query/`;
  const response = await (input.fetchFn ?? fetch)(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query: {
        kind: "HogQLQuery",
        query: compactQuery(input.query),
      },
      name: input.queryName,
      refresh: "blocking",
    }),
  });

  if (!response.ok) {
    throw new Error(`PostHog Query API returned ${response.status}.`);
  }

  const body = (await response.json()) as PostHogQueryResult;
  return {
    value: readFirstNumber(body),
    source: {
      endpoint,
      query: compactQuery(input.query),
      response: body,
      window: {
        start: input.window.start.toISOString(),
        end: input.window.end.toISOString(),
      },
    },
  };
}

export function readPostHogApiHost(metadata: Record<string, unknown>) {
  const value = typeof metadata.apiHost === "string" ? metadata.apiHost.trim() : "";
  if (!value) return DEFAULT_POSTHOG_API_HOST;
  return value.replace(/\/+$/, "");
}

export function parsePostHogEventNames(value: unknown, fallback: string[]) {
  if (Array.isArray(value)) {
    const names = value.filter((item): item is string => typeof item === "string");
    return normalizeEventNames(names, fallback);
  }
  if (typeof value === "string") {
    return normalizeEventNames(value.split(","), fallback);
  }
  return fallback;
}

function normalizeEventNames(value: string[], fallback: string[]) {
  const names = value.map((item) => item.trim()).filter(Boolean);
  return names.length > 0 ? names.slice(0, 10) : fallback;
}

function readFirstNumber(body: PostHogQueryResult) {
  const first = body.results?.[0]?.[0];
  if (typeof first === "number" && Number.isFinite(first)) return first;
  if (typeof first === "string") {
    const parsed = Number(first);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function hogqlDate(date: Date) {
  return hogqlString(date.toISOString());
}

function hogqlString(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function compactQuery(query: string) {
  return query
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function fetchOption(fetchFn: typeof fetch | undefined) {
  return fetchFn ? { fetchFn } : {};
}
