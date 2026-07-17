import type { ConnectedIntegration, IntegrationProviderId, IntegrationToolCard } from "./types";
import { integrationProviderPointer } from "./types";

// Cap on Level 1 cards surfaced per activated provider so an ambiguous prompt
// cannot recreate flat full-catalog exposure.
export const MAX_LEVEL1_TOOLS_PER_PROVIDER = 4;

export const INTEGRATION_PROVIDER_LABELS: Record<IntegrationProviderId, string> = {
  linear: "Linear",
  github: "GitHub",
};

const INTEGRATION_PROVIDER_SUMMARIES: Record<IntegrationProviderId, string> = {
  linear: "read issues, projects, teams, and comments from the connected Linear workspace",
  github: "read repositories, issues, and pull requests the connected GitHub installation can see",
};

export function connectedIntegrationForProvider(
  provider: IntegrationProviderId,
): ConnectedIntegration {
  return {
    provider,
    label: INTEGRATION_PROVIDER_LABELS[provider],
    summary: INTEGRATION_PROVIDER_SUMMARIES[provider],
    pointer: integrationProviderPointer(provider),
  };
}

// Linear cards map 1:1 onto tools of Linear's hosted MCP server: execution and
// inspect resolve the live catalog by name, so these signatures are curated
// partial views (strict: false) and drift in optional fields is tolerated.
const LINEAR_TOOL_CARDS: readonly IntegrationToolCard[] = [
  {
    pointer: "tool://linear/list_issues",
    provider: "linear",
    name: "list_issues",
    summary:
      "List Linear issues, filterable by team, project, assignee, state, or a free-text query.",
    sideEffect: "read",
    level1: true,
    strict: false,
    fields: [
      { name: "query", type: "string", description: "Free-text filter over issue titles." },
      { name: "teamId", type: "string", description: "Team id or key to scope the list." },
      { name: "assigneeId", type: "string", description: "Filter by assignee user id." },
      { name: "projectId", type: "string" },
      { name: "stateId", type: "string", description: "Workflow state to filter by." },
      { name: "limit", type: "number", description: "Max issues to return." },
    ],
  },
  {
    pointer: "tool://linear/get_issue",
    provider: "linear",
    name: "get_issue",
    summary: "Fetch one Linear issue by id or key (for example ENG-123) with full details.",
    sideEffect: "read",
    level1: true,
    strict: false,
    fields: [{ name: "id", type: "string", required: true, description: "Issue id or key." }],
  },
  {
    pointer: "tool://linear/list_my_issues",
    provider: "linear",
    name: "list_my_issues",
    summary: "List Linear issues assigned to the connected user.",
    sideEffect: "read",
    level1: true,
    strict: false,
    fields: [{ name: "limit", type: "number", description: "Max issues to return." }],
  },
  {
    pointer: "tool://linear/list_comments",
    provider: "linear",
    name: "list_comments",
    summary: "List the comments on one Linear issue.",
    sideEffect: "read",
    level1: true,
    strict: false,
    fields: [{ name: "issueId", type: "string", required: true, description: "Issue id or key." }],
  },
  {
    pointer: "tool://linear/list_teams",
    provider: "linear",
    name: "list_teams",
    summary: "List the teams in the connected Linear workspace.",
    sideEffect: "read",
    level1: false,
    strict: false,
    fields: [{ name: "query", type: "string", description: "Free-text filter over team names." }],
  },
  {
    pointer: "tool://linear/list_projects",
    provider: "linear",
    name: "list_projects",
    summary: "List Linear projects, optionally filtered by team or a free-text query.",
    sideEffect: "read",
    level1: false,
    strict: false,
    fields: [
      { name: "teamId", type: "string" },
      { name: "query", type: "string", description: "Free-text filter over project names." },
    ],
  },
  {
    pointer: "tool://linear/get_project",
    provider: "linear",
    name: "get_project",
    summary: "Fetch one Linear project by id or name with full details.",
    sideEffect: "read",
    level1: false,
    strict: false,
    fields: [{ name: "query", type: "string", required: true, description: "Project id or name." }],
  },
  {
    pointer: "tool://linear/list_users",
    provider: "linear",
    name: "list_users",
    summary: "List the members of the connected Linear workspace.",
    sideEffect: "read",
    level1: false,
    strict: false,
    fields: [{ name: "query", type: "string", description: "Free-text filter over user names." }],
  },
];

// GitHub cards execute through the workspace installation token against the
// repository allowlist; the app owns these schemas fully (strict: true).
const GITHUB_REPOSITORY_FIELD = {
  name: "repository",
  type: "string",
  required: true,
  description: 'Full repository name like "owner/repo". Must be a connected repository.',
} as const;

const GITHUB_TOOL_CARDS: readonly IntegrationToolCard[] = [
  {
    pointer: "tool://github/list_repositories",
    provider: "github",
    name: "list_repositories",
    summary: "List the GitHub repositories connected to this workspace.",
    sideEffect: "read",
    level1: false,
    strict: true,
    fields: [],
  },
  {
    pointer: "tool://github/list_issues",
    provider: "github",
    name: "list_issues",
    summary: "List issues in a connected GitHub repository (excludes pull requests).",
    sideEffect: "read",
    level1: true,
    strict: true,
    fields: [
      GITHUB_REPOSITORY_FIELD,
      { name: "state", type: "string", enumValues: ["open", "closed", "all"] },
      { name: "labels", type: "string", description: "Comma-separated label names to filter by." },
      { name: "limit", type: "number", description: "Max issues to return (default 20, max 50)." },
    ],
  },
  {
    pointer: "tool://github/get_issue",
    provider: "github",
    name: "get_issue",
    summary: "Fetch one GitHub issue with its body and recent comments.",
    sideEffect: "read",
    level1: true,
    strict: true,
    fields: [
      GITHUB_REPOSITORY_FIELD,
      { name: "number", type: "number", required: true, description: "Issue number." },
    ],
  },
  {
    pointer: "tool://github/list_pull_requests",
    provider: "github",
    name: "list_pull_requests",
    summary: "List pull requests in a connected GitHub repository.",
    sideEffect: "read",
    level1: true,
    strict: true,
    fields: [
      GITHUB_REPOSITORY_FIELD,
      { name: "state", type: "string", enumValues: ["open", "closed", "all"] },
      { name: "limit", type: "number", description: "Max PRs to return (default 20, max 50)." },
    ],
  },
  {
    pointer: "tool://github/get_pull_request",
    provider: "github",
    name: "get_pull_request",
    summary: "Fetch one GitHub pull request with its body, reviews, and recent comments.",
    sideEffect: "read",
    level1: true,
    strict: true,
    fields: [
      GITHUB_REPOSITORY_FIELD,
      { name: "number", type: "number", required: true, description: "Pull request number." },
    ],
  },
];

const CARDS_BY_PROVIDER: Record<IntegrationProviderId, readonly IntegrationToolCard[]> = {
  linear: LINEAR_TOOL_CARDS,
  github: GITHUB_TOOL_CARDS,
};

export function integrationToolCardsForProvider(provider: IntegrationProviderId) {
  return CARDS_BY_PROVIDER[provider];
}

export function integrationToolCardsForProviders(providers: readonly IntegrationProviderId[]) {
  return providers.flatMap((provider) => CARDS_BY_PROVIDER[provider]);
}

export function level1IntegrationToolCards(providers: readonly IntegrationProviderId[]) {
  return providers.flatMap((provider) =>
    CARDS_BY_PROVIDER[provider]
      .filter((card) => card.level1)
      .slice(0, MAX_LEVEL1_TOOLS_PER_PROVIDER),
  );
}

export function findIntegrationToolCard(provider: IntegrationProviderId, tool: string) {
  return CARDS_BY_PROVIDER[provider].find((card) => card.name === tool) ?? null;
}
