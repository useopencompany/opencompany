import { getDb } from "@opencompany/db/client";
import { workspaceIntegrationResources, workspaceIntegrations } from "@opencompany/db/schema";
import { and, eq } from "drizzle-orm";
import { getGitHubWorkInstallationToken } from "@/lib/integrations/github";
import {
  GITHUB_INTEGRATION_PROVIDER,
  GITHUB_REPOSITORY_RESOURCE_TYPE,
} from "@/lib/integrations/service";
import { type KpiProvider, truncateToHourUtc } from "@/lib/kpis/types";

type GitHubKpiConnection = {
  installationId: string;
  repos: Array<{ owner: string; name: string }>;
};

// GraphQL alias batch size: a totalCount-only repository query costs ~1 point,
// so even large installations stay far inside the per-installation budget.
const REPOS_PER_QUERY = 50;

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

  async fetchMetric({ connection, range }) {
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
