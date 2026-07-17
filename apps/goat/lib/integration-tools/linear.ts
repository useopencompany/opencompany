import { getDb } from "@opencompany/db/client";
import {
  loadGoatIntegrationCredential,
  markGoatIntegrationStatus,
} from "@opencompany/db/goat-integrations";
import type { ResolvedLinearCredentialSource } from "./connections";
import type { IntegrationToolExecutor } from "./dispatcher";

// Linear chat tools execute direct GraphQL reads with whichever personal
// Linear credential the user has: the ingest OAuth token (plain access_token)
// or, as a fallback, the Linear MCP connector's OAuth token.

const RECONNECT_MESSAGE =
  "Linear authorization failed — reconnect Linear in Settings → Integrations.";

const ISSUE_LIST_SELECTION = `identifier title url priorityLabel updatedAt state { name type } assignee { displayName } team { key }`;

const LIST_ISSUES_QUERY = `query GoatChatLinearListIssues($limit: Int!, $filter: IssueFilter) {
  issues(first: $limit, filter: $filter, orderBy: updatedAt) {
    nodes { ${ISSUE_LIST_SELECTION} }
  }
}`;

const GET_ISSUE_QUERY = `query GoatChatLinearGetIssue($id: String!) {
  issue(id: $id) {
    identifier
    url
    title
    description
    priorityLabel
    dueDate
    createdAt
    updatedAt
    state { name type }
    assignee { displayName }
    creator { displayName }
    project { name }
    team { key name }
    labels { nodes { name } }
    comments(first: 15, orderBy: createdAt) {
      nodes { body createdAt user { displayName } }
    }
  }
}`;

const LIST_MY_ISSUES_QUERY = `query GoatChatLinearListMyIssues($limit: Int!) {
  viewer {
    assignedIssues(
      first: $limit
      orderBy: updatedAt
      filter: { state: { type: { nin: ["completed", "canceled"] } } }
    ) {
      nodes { ${ISSUE_LIST_SELECTION} }
    }
  }
}`;

const PROJECT_SELECTION = `name url state progress targetDate updatedAt lead { displayName } teams { nodes { key } }`;

const LIST_PROJECTS_QUERY = `query GoatChatLinearListProjects($limit: Int!, $filter: ProjectFilter) {
  projects(first: $limit, filter: $filter, orderBy: updatedAt) {
    nodes { ${PROJECT_SELECTION} }
  }
}`;

const LIST_TEAM_PROJECTS_QUERY = `query GoatChatLinearListTeamProjects($limit: Int!, $teamKey: String!) {
  teams(first: 1, filter: { key: { eq: $teamKey } }) {
    nodes {
      key
      projects(first: $limit) { nodes { ${PROJECT_SELECTION} } }
    }
  }
}`;

const LIST_TEAMS_QUERY = `query GoatChatLinearListTeams {
  teams(first: 50) { nodes { id key name } }
}`;

export function createLinearIntegrationToolExecutor(input: {
  userWorkosId: string;
  sources: readonly ResolvedLinearCredentialSource[];
  signal?: AbortSignal;
}): IntegrationToolExecutor {
  let resolved: Promise<{ token: string; integrationId: string }> | null = null;
  const resolveToken = () => {
    resolved ??= (async () => {
      for (const source of input.sources) {
        const credential = await loadGoatIntegrationCredential({
          userWorkosId: input.userWorkosId,
          integrationId: source.integrationId,
          provider: "linear",
          kind: "oauth_token",
          db: getDb(),
        });
        const token =
          source.kind === "ingest"
            ? readString(credential?.payload.access_token)
            : readString(asRecord(credential?.payload.tokens)?.access_token);
        if (token) return { token, integrationId: source.integrationId };
      }
      throw new Error(RECONNECT_MESSAGE);
    })();
    return resolved;
  };

  const graphql = async <T>(query: string, variables?: Record<string, unknown>) => {
    const { token, integrationId } = await resolveToken();
    try {
      return await linearGraphql<T>({ token, query, variables, signal: input.signal });
    } catch (error) {
      if (isLinearAuthError(error)) {
        await markGoatIntegrationStatus({
          userWorkosId: input.userWorkosId,
          integrationId,
          provider: "linear",
          status: "needs_reauth",
          statusReason: "Linear rejected the stored token during a chat tool call.",
          db: getDb(),
        }).catch(() => {});
        throw new Error(RECONNECT_MESSAGE);
      }
      throw error;
    }
  };

  return async ({ tool, args }) => {
    switch (tool.name) {
      case "linear_list_issues": {
        const filter = buildIssueFilter(args);
        const data = await graphql<{ issues?: { nodes?: unknown[] } }>(LIST_ISSUES_QUERY, {
          limit: clampLimit(args.limit, 20, 50),
          ...(filter ? { filter } : {}),
        });
        return { issues: data.issues?.nodes ?? [] };
      }
      case "linear_get_issue": {
        const data = await graphql<{ issue?: unknown }>(GET_ISSUE_QUERY, {
          id: String(args.id),
        });
        if (!data.issue) throw new Error(`Linear issue ${JSON.stringify(args.id)} was not found.`);
        return { issue: data.issue };
      }
      case "linear_list_my_issues": {
        const data = await graphql<{ viewer?: { assignedIssues?: { nodes?: unknown[] } } }>(
          LIST_MY_ISSUES_QUERY,
          { limit: clampLimit(args.limit, 20, 50) },
        );
        return { issues: data.viewer?.assignedIssues?.nodes ?? [] };
      }
      case "linear_list_projects": {
        const limit = clampLimit(args.limit, 20, 50);
        const teamKey = readString(args.teamKey)?.toUpperCase();
        if (teamKey) {
          const data = await graphql<{
            teams?: { nodes?: Array<{ key?: string; projects?: { nodes?: unknown[] } }> };
          }>(LIST_TEAM_PROJECTS_QUERY, { limit, teamKey });
          const team = data.teams?.nodes?.[0];
          if (!team) throw new Error(`Linear team ${JSON.stringify(teamKey)} was not found.`);
          return { projects: filterProjectsByName(team.projects?.nodes ?? [], args.query) };
        }
        const query = readString(args.query);
        const data = await graphql<{ projects?: { nodes?: unknown[] } }>(LIST_PROJECTS_QUERY, {
          limit,
          ...(query ? { filter: { name: { containsIgnoreCase: query } } } : {}),
        });
        return { projects: data.projects?.nodes ?? [] };
      }
      case "linear_list_teams": {
        const data = await graphql<{ teams?: { nodes?: unknown[] } }>(LIST_TEAMS_QUERY);
        return { teams: data.teams?.nodes ?? [] };
      }
      default:
        throw new Error(`Unsupported Linear tool ${tool.name}.`);
    }
  };
}

function buildIssueFilter(args: Record<string, unknown>) {
  const filter: Record<string, unknown> = {};
  const query = readString(args.query);
  const teamKey = readString(args.teamKey);
  const assignee = readString(args.assignee);
  const state = readString(args.state);
  if (query) filter.title = { containsIgnoreCase: query };
  if (teamKey) filter.team = { key: { eq: teamKey.toUpperCase() } };
  if (assignee) filter.assignee = { displayName: { containsIgnoreCase: assignee } };
  if (state) filter.state = { type: { eq: state } };
  return Object.keys(filter).length > 0 ? filter : null;
}

function filterProjectsByName(projects: unknown[], query: unknown) {
  const fragment = readString(query)?.toLowerCase();
  if (!fragment) return projects;
  return projects.filter((project) =>
    readString(asRecord(project)?.name)?.toLowerCase().includes(fragment),
  );
}

async function linearGraphql<T>(input: {
  token: string;
  query: string;
  variables?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
}): Promise<T> {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.token}`,
    },
    body: JSON.stringify({
      query: input.query,
      ...(input.variables ? { variables: input.variables } : {}),
    }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (response.status === 401 || response.status === 403) {
    throw new LinearAuthError(`Linear GraphQL request failed with ${response.status}.`);
  }
  if (!response.ok) {
    throw new Error(`Linear GraphQL request failed with ${response.status}.`);
  }

  const result = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (result.errors && result.errors.length > 0) {
    const message = result.errors[0]?.message ?? "an unknown error";
    if (/authenticat|unauthorized|access token/i.test(message)) {
      throw new LinearAuthError(`Linear GraphQL returned ${message}.`);
    }
    throw new Error(`Linear GraphQL returned ${message}.`);
  }
  if (!result.data) throw new Error("Linear GraphQL returned no data.");
  return result.data;
}

class LinearAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearAuthError";
  }
}

function isLinearAuthError(error: unknown): error is LinearAuthError {
  return error instanceof LinearAuthError;
}

function clampLimit(value: unknown, fallback: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
