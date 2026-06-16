import {
  emptyDayBuckets,
  type KpiDatapointValue,
  type KpiProvider,
  truncateToDayUtc,
} from "@/lib/kpis/types";
import { loadMcpAccessToken } from "@/lib/mcp/access-token";
import { LINEAR_MCP_SERVER_KEY } from "@/lib/mcp/data";

type LinearKpiConnection = { accessToken: string };

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const PAGE_SIZE = 100;
// 20 pages × 100 issues bounds one refresh; beyond that the day counts are
// truncated, which a founder dashboard tolerates better than rate-limit burn.
const MAX_PAGES = 20;

export const linearKpiProvider: KpiProvider<LinearKpiConnection> = {
  id: "linear",
  label: "Linear",
  catalog: [
    {
      key: "linear.new_issues",
      label: "New issues",
      description: "Issues created in your Linear workspace, counted per day.",
      metricType: "event",
      unit: "count",
      defaultViz: "bar",
      defaultTimeRangeDays: 7,
      refreshIntervalMinutes: 15,
    },
  ],

  async getConnection(workspaceId) {
    const accessToken = await loadMcpAccessToken(workspaceId, LINEAR_MCP_SERVER_KEY);
    return accessToken ? { accessToken } : null;
  },

  async fetchMetric({ connection, range }) {
    // Event metric: count timestamped entities into zero-filled UTC day buckets.
    // Re-fetching the whole window rewrites recent buckets, so deletions and
    // backdated issues heal on the next refresh.
    const buckets = emptyDayBuckets(range);
    let after: string | null = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result: LinearIssuesPage = await fetchIssuesPage(
        connection.accessToken,
        range.start,
        after,
      );
      for (const createdAt of result.createdAtTimestamps) {
        const bucketTs = truncateToDayUtc(createdAt).getTime();
        const bucket = buckets.get(bucketTs);
        if (bucket) bucket.value += 1;
      }
      if (!result.hasNextPage || !result.endCursor) break;
      after = result.endCursor;
    }

    return [...buckets.values()].sort(
      (a: KpiDatapointValue, b: KpiDatapointValue) => a.ts.getTime() - b.ts.getTime(),
    );
  },
};

type LinearIssuesPage = {
  createdAtTimestamps: Date[];
  hasNextPage: boolean;
  endCursor: string | null;
};

async function fetchIssuesPage(
  accessToken: string,
  since: Date,
  after: string | null,
): Promise<LinearIssuesPage> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `
        query NewIssues($filter: IssueFilter, $first: Int!, $after: String) {
          issues(filter: $filter, first: $first, after: $after) {
            nodes { createdAt }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      variables: {
        filter: { createdAt: { gte: since.toISOString() } },
        first: PAGE_SIZE,
        after,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Linear GraphQL request failed with ${response.status}.`);
  }

  const body = (await response.json()) as {
    data?: {
      issues?: {
        nodes?: Array<{ createdAt?: unknown }>;
        pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
      };
    };
    errors?: Array<{ message?: string }>;
  };
  const issues = body.data?.issues;
  if (!issues) {
    throw new Error(body.errors?.[0]?.message ?? "Linear GraphQL returned no issue data.");
  }

  const createdAtTimestamps: Date[] = [];
  for (const node of issues.nodes ?? []) {
    if (typeof node.createdAt !== "string") continue;
    const createdAt = new Date(node.createdAt);
    if (!Number.isNaN(createdAt.getTime())) createdAtTimestamps.push(createdAt);
  }

  return {
    createdAtTimestamps,
    hasNextPage: issues.pageInfo?.hasNextPage === true,
    endCursor: typeof issues.pageInfo?.endCursor === "string" ? issues.pageInfo.endCursor : null,
  };
}
