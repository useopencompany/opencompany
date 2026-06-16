import { type KpiDatapointValue, type KpiProvider, truncateToDayUtc } from "@/lib/kpis/types";
import { loadMcpAccessToken } from "@/lib/mcp/access-token";
import { POSTHOG_MCP_SERVER_KEY } from "@/lib/mcp/data";

type PostHogKpiConnection = { accessToken: string };

// PostHog Cloud regions; project discovery resolves which one the token
// belongs to once, at metric creation, and pins it in the metric config.
const POSTHOG_API_HOSTS = ["https://us.posthog.com", "https://eu.posthog.com"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export const posthogKpiProvider: KpiProvider<PostHogKpiConnection> = {
  id: "posthog",
  label: "PostHog",
  catalog: [
    {
      key: "posthog.weekly_active_users",
      label: "Weekly active users",
      description: "Unique users active in the trailing 7 days, tracked daily.",
      metricType: "bucketed",
      unit: "users",
      defaultViz: "line",
      defaultTimeRangeDays: 30,
      // Daily-granularity series; PostHog's /query budget is org-wide, so poll gently.
      refreshIntervalMinutes: 60,
    },
  ],

  async getConnection(workspaceId) {
    const accessToken = await loadMcpAccessToken(workspaceId, POSTHOG_MCP_SERVER_KEY);
    return accessToken ? { accessToken } : null;
  },

  async resolveConfig(connection) {
    for (const apiHost of POSTHOG_API_HOSTS) {
      const projectId = await discoverProjectId(connection.accessToken, apiHost);
      if (projectId !== null) return { apiHost, projectId };
    }
    throw new Error(
      "Could not find a PostHog project for the connected account. Reconnect PostHog in Settings and try again.",
    );
  },

  async fetchMetric({ connection, config, range }) {
    const apiHost = typeof config.apiHost === "string" ? config.apiHost : null;
    const projectId =
      typeof config.projectId === "number" || typeof config.projectId === "string"
        ? config.projectId
        : null;
    if (!apiHost || projectId === null) {
      throw new Error("PostHog metric is missing its project configuration.");
    }

    const days = Math.max(1, Math.ceil((range.end.getTime() - range.start.getTime()) / DAY_MS));
    const response = await fetch(`${apiHost}/api/projects/${projectId}/query/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: {
          kind: "TrendsQuery",
          interval: "day",
          dateRange: { date_from: `-${days}d` },
          series: [{ kind: "EventsNode", event: null, math: "weekly_active" }],
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`PostHog query request failed with ${response.status}.`);
    }

    const body = (await response.json()) as {
      results?: Array<{ data?: unknown; days?: unknown }>;
    };
    const series = body.results?.[0];
    const values = Array.isArray(series?.data) ? series.data : null;
    const dayLabels = Array.isArray(series?.days) ? series.days : null;
    if (!values || !dayLabels) {
      throw new Error("PostHog query returned an unexpected trends shape.");
    }

    // Bucketed metric: the provider computes the daily series; upserting by
    // bucket means every refresh heals the whole fetched window.
    const datapoints: KpiDatapointValue[] = [];
    for (let index = 0; index < Math.min(values.length, dayLabels.length); index += 1) {
      const value = values[index];
      const dayLabel = dayLabels[index];
      if (typeof value !== "number" || typeof dayLabel !== "string") continue;
      const ts = new Date(`${dayLabel}T00:00:00.000Z`);
      if (Number.isNaN(ts.getTime())) continue;
      datapoints.push({ ts: truncateToDayUtc(ts), value });
    }
    return datapoints;
  },
};

async function discoverProjectId(
  accessToken: string,
  apiHost: string,
): Promise<number | string | null> {
  const response = await fetch(`${apiHost}/api/projects/`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // A token minted for the other region 401s — that's discovery, not an error.
  if (!response.ok) return null;

  const body = (await response.json()) as {
    results?: Array<{ id?: unknown; name?: unknown }>;
  };
  const project = body.results?.[0];
  if (!project) return null;
  return typeof project.id === "number" || typeof project.id === "string" ? project.id : null;
}
