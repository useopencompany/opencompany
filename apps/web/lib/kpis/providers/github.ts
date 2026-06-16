import { getDb } from "@opencompany/db/client";
import { workspaceIntegrationResources, workspaceIntegrations } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { getGitHubWorkInstallationToken } from "@/lib/integrations/github";
import {
  GITHUB_INTEGRATION_PROVIDER,
  GITHUB_REPOSITORY_RESOURCE_TYPE,
} from "@/lib/integrations/service";
import {
  emptyDayBuckets,
  type KpiDatapointValue,
  type KpiProvider,
  truncateToDayUtc,
  truncateToHourUtc,
} from "@/lib/kpis/types";

type GitHubKpiConnection = {
  installationId: string;
  repos: Array<{ owner: string; name: string }>;
};

// GraphQL alias batch size: a totalCount-only repository query costs ~1 point,
// so even large installations stay far inside the per-installation budget.
const REPOS_PER_QUERY = 50;
const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES_PER_QUERY = 10;
const SEARCH_FILTER_MAX_LENGTH = 160;
const SEARCH_QUERY_MAX_LENGTH = 240;

export const githubKpiProvider: KpiProvider<GitHubKpiConnection> = {
  id: "github",
  label: "GitHub",
  catalog: [
    {
      key: "github.open_prs",
      label: "Open pull requests",
      description: "Pull requests currently open across your connected repositories.",
      metricType: "current",
      unit: "count",
      defaultViz: "number",
      defaultTimeRangeDays: 7,
      refreshIntervalMinutes: 15,
    },
    {
      key: "github.pull_request_search_count",
      label: "Pull request search count",
      description: "Count pull requests matching GitHub search filters across connected repos.",
      metricType: "event",
      unit: "count",
      defaultViz: "bar",
      defaultTimeRangeDays: 30,
      refreshIntervalMinutes: 30,
      configFields: [
        {
          key: "search",
          label: "Search filters",
          description:
            "Example: is:merged author:octocat. Time range and repository scope are managed by the card.",
          placeholder: "is:merged author:octocat",
          required: true,
          maxLength: SEARCH_FILTER_MAX_LENGTH,
        },
      ],
    },
  ],

  async getConnection(workspaceId) {
    const db = getDb();
    const [integration] = await db
      .select({ id: workspaceIntegrations.id, externalId: workspaceIntegrations.externalId })
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.provider, GITHUB_INTEGRATION_PROVIDER),
          eq(workspaceIntegrations.status, "connected"),
        ),
      )
      .limit(1);
    if (!integration) return null;

    const resources = await db
      .select({ fullName: workspaceIntegrationResources.name })
      .from(workspaceIntegrationResources)
      .where(
        and(
          eq(workspaceIntegrationResources.workspaceId, workspaceId),
          eq(workspaceIntegrationResources.integrationId, integration.id),
          eq(workspaceIntegrationResources.resourceType, GITHUB_REPOSITORY_RESOURCE_TYPE),
          eq(workspaceIntegrationResources.status, "available"),
        ),
      );

    const repos = resources
      .map((resource) => {
        const [owner, name] = resource.fullName.split("/");
        return owner && name ? { owner, name } : null;
      })
      .filter((repo): repo is { owner: string; name: string } => repo !== null);

    return { installationId: integration.externalId, repos };
  },

  async fetchMetric({ connection, entry, config, range }) {
    if (entry.key === "github.pull_request_search_count") {
      return fetchPullRequestSearchCount({ connection, config, range });
    }

    if (connection.repos.length === 0) {
      return [{ ts: truncateToHourUtc(range.end), value: 0 }];
    }

    const token = await getGitHubWorkInstallationToken(connection.installationId);
    let openPrs = 0;
    for (let offset = 0; offset < connection.repos.length; offset += REPOS_PER_QUERY) {
      const chunk = connection.repos.slice(offset, offset + REPOS_PER_QUERY);
      openPrs += await fetchOpenPrCount(token, chunk);
    }

    // A "current" metric: snapshot the live total on an hour bucket; the series
    // accumulates across refreshes (history is not reconstructable later).
    return [{ ts: truncateToHourUtc(range.end), value: openPrs }];
  },
};

async function fetchPullRequestSearchCount(input: {
  connection: GitHubKpiConnection;
  config: Record<string, unknown>;
  range: { start: Date; end: Date };
}): Promise<KpiDatapointValue[]> {
  const filters = normalizeGitHubPullRequestSearchFilters(input.config.search);
  const buckets = emptyDayBuckets(input.range);
  if (input.connection.repos.length === 0) return sortDatapoints(buckets);

  const token = await getGitHubWorkInstallationToken(input.connection.installationId);
  const bucketBy = filters.hasMergedQualifier ? "merged" : "created";

  const repoChunks = chunkReposForSearch({
    repos: input.connection.repos,
    filters: filters.value,
    bucketBy,
    range: input.range,
  });
  for (const repos of repoChunks) {
    const query = buildPullRequestSearchQuery({
      repos,
      filters: filters.value,
      bucketBy,
      range: input.range,
    });

    let after: string | null = null;
    for (let page = 0; page < SEARCH_MAX_PAGES_PER_QUERY; page += 1) {
      const result = await fetchPullRequestSearchPage({ token, query, after, bucketBy });
      for (const timestamp of result.timestamps) {
        const bucket = buckets.get(truncateToDayUtc(timestamp).getTime());
        if (bucket) bucket.value += 1;
      }
      if (!result.hasNextPage) break;
      if (!result.endCursor || page === SEARCH_MAX_PAGES_PER_QUERY - 1) {
        throw new Error("GitHub search matched too many pull requests. Narrow the filters.");
      }
      after = result.endCursor;
    }
  }

  return sortDatapoints(buckets);
}

export function normalizeGitHubPullRequestSearchFilters(input: unknown): {
  value: string;
  hasMergedQualifier: boolean;
} {
  if (typeof input !== "string") throw new Error("GitHub search filters are required.");
  const value = input.trim().replace(/\s+/g, " ");
  if (!value) throw new Error("GitHub search filters are required.");
  if (value.length > SEARCH_FILTER_MAX_LENGTH) {
    throw new Error(
      `GitHub search filters must be ${SEARCH_FILTER_MAX_LENGTH} characters or fewer.`,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("GitHub search filters cannot contain control characters.");
  }
  if (/\b(repo|org|user):/i.test(value)) {
    throw new Error("Repository and organization scope are managed by the KPI connection.");
  }
  if (/\b(created|updated|closed|merged):/i.test(value)) {
    throw new Error("Date filters are managed by the KPI card time range.");
  }
  if (/\b(is|type):issue\b/i.test(value)) {
    throw new Error("This KPI only supports pull request searches.");
  }

  return { value, hasMergedQualifier: /\bis:merged\b/i.test(value) };
}

function buildPullRequestSearchQuery(input: {
  repos: Array<{ owner: string; name: string }>;
  filters: string;
  bucketBy: "created" | "merged";
  range: { start: Date; end: Date };
}): string {
  const repoScope = input.repos.map((repo) => `repo:${repo.owner}/${repo.name}`).join(" OR ");
  const dateQualifier = input.bucketBy === "merged" ? "merged" : "created";
  const mergedQualifier =
    input.bucketBy === "merged" && !/\bis:merged\b/i.test(input.filters) ? " is:merged" : "";
  return `(${repoScope}) is:pr${mergedQualifier} ${input.filters} ${dateQualifier}:${formatSearchDate(input.range.start)}..${formatSearchDate(input.range.end)}`;
}

function chunkReposForSearch(input: {
  repos: Array<{ owner: string; name: string }>;
  filters: string;
  bucketBy: "created" | "merged";
  range: { start: Date; end: Date };
}): Array<Array<{ owner: string; name: string }>> {
  const chunks: Array<Array<{ owner: string; name: string }>> = [];
  let current: Array<{ owner: string; name: string }> = [];

  for (const repo of input.repos) {
    const candidate = [...current, repo];
    const query = buildPullRequestSearchQuery({ ...input, repos: candidate });
    if (query.length <= SEARCH_QUERY_MAX_LENGTH) {
      current = candidate;
      continue;
    }

    if (current.length === 0) {
      throw new Error("GitHub search filters are too long for this repository name.");
    }
    chunks.push(current);
    const singleRepoQuery = buildPullRequestSearchQuery({ ...input, repos: [repo] });
    if (singleRepoQuery.length > SEARCH_QUERY_MAX_LENGTH) {
      throw new Error("GitHub search filters are too long for this repository name.");
    }
    current = [repo];
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

type PullRequestSearchPage = {
  timestamps: Date[];
  hasNextPage: boolean;
  endCursor: string | null;
};

async function fetchPullRequestSearchPage(input: {
  token: string;
  query: string;
  after: string | null;
  bucketBy: "created" | "merged";
}): Promise<PullRequestSearchPage> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      query: `
        query PullRequestSearch($query: String!, $first: Int!, $after: String) {
          search(type: ISSUE, query: $query, first: $first, after: $after) {
            nodes {
              ... on PullRequest {
                createdAt
                mergedAt
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      variables: {
        query: input.query,
        first: SEARCH_PAGE_SIZE,
        after: input.after,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with ${response.status}.`);
  }

  const body = (await response.json()) as {
    data?: {
      search?: {
        nodes?: Array<{ createdAt?: unknown; mergedAt?: unknown } | null>;
        pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
      };
    };
    errors?: Array<{ message?: string }>;
  };
  const search = body.data?.search;
  if (!search) {
    throw new Error(body.errors?.[0]?.message ?? "GitHub GraphQL returned no search data.");
  }

  const timestamps: Date[] = [];
  for (const node of search.nodes ?? []) {
    const rawTimestamp = input.bucketBy === "merged" ? node?.mergedAt : node?.createdAt;
    if (typeof rawTimestamp !== "string") continue;
    const timestamp = new Date(rawTimestamp);
    if (!Number.isNaN(timestamp.getTime())) timestamps.push(timestamp);
  }

  return {
    timestamps,
    hasNextPage: search.pageInfo?.hasNextPage === true,
    endCursor: typeof search.pageInfo?.endCursor === "string" ? search.pageInfo.endCursor : null,
  };
}

function sortDatapoints(buckets: Map<number, KpiDatapointValue>): KpiDatapointValue[] {
  return [...buckets.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
}

function formatSearchDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function fetchOpenPrCount(
  token: string,
  repos: Array<{ owner: string; name: string }>,
): Promise<number> {
  const fields = repos
    .map(
      (repo, index) =>
        `r${index}: repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.name)}) { pullRequests(states: OPEN) { totalCount } }`,
    )
    .join("\n");

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ query: `query OpenPrCounts {\n${fields}\n}` }),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with ${response.status}.`);
  }

  const body = (await response.json()) as {
    data?: Record<string, { pullRequests?: { totalCount?: unknown } } | null>;
    errors?: Array<{ message?: string }>;
  };
  // Repos can drop out between resource sync and fetch (deleted, access lost);
  // GitHub nulls those aliases and reports a NOT_FOUND error alongside the
  // resolvable data. Count what resolved, fail only when nothing did.
  if (!body.data) {
    const message = body.errors?.[0]?.message ?? "GitHub GraphQL returned no data.";
    throw new Error(message);
  }

  let total = 0;
  for (const entry of Object.values(body.data)) {
    const count = entry?.pullRequests?.totalCount;
    if (typeof count === "number") total += count;
  }
  return total;
}
