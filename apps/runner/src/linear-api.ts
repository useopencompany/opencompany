import { createLogger } from "@opencompany/observability";

// Read-only Linear GraphQL helpers for the flush worker's prompt enrichment
// (live issue snapshot with comments). Enrichment failures must never fail a
// flush: the worker falls back to the buffered webhook payloads.

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-linear-api" });

const LINEAR_API_TIMEOUT_MS = 10_000;
export const LINEAR_SNAPSHOT_COMMENT_LIMIT = 50;

export type LinearIssueSnapshot = {
  organizationId: string;
  organizationUrlKey?: string;
  issueId: string;
  identifier?: string;
  url?: string;
  title: string;
  description?: string;
  state?: string;
  stateType?: string;
  priority?: string;
  assigneeName?: string;
  creatorName?: string;
  projectName?: string;
  labels?: string[];
  dueDate?: string;
  estimate?: number;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  canceledAt?: string;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  comments: Array<{
    id: string;
    body: string;
    authorName?: string;
    createdAt?: string;
    url?: string;
  }>;
};

const ISSUE_SNAPSHOT_QUERY = `query GoatLinearIssueSnapshot($id: String!, $commentLimit: Int!) {
  issue(id: $id) {
    id
    identifier
    url
    title
    description
    priorityLabel
    estimate
    dueDate
    createdAt
    updatedAt
    completedAt
    canceledAt
    state { name type }
    assignee { name displayName }
    creator { name displayName }
    project { name }
    team { id key name organization { id urlKey } }
    labels { nodes { name } }
    comments(first: $commentLimit, orderBy: createdAt) {
      nodes {
        id
        body
        url
        createdAt
        user { name displayName }
      }
    }
  }
}`;

// Returns null when the issue is gone or unreadable (deleted issue, revoked
// token); the caller then normalizes from the buffered events instead.
export async function fetchLinearIssueSnapshot(input: {
  token: string;
  issueId: string;
  suppressErrors?: boolean;
}): Promise<LinearIssueSnapshot | null> {
  try {
    const data = await linearGraphqlRequest<{ issue?: Record<string, unknown> | null }>({
      token: input.token,
      query: ISSUE_SNAPSHOT_QUERY,
      variables: { id: input.issueId, commentLimit: LINEAR_SNAPSHOT_COMMENT_LIMIT },
    });
    const issue = data.issue;
    if (!issue) return null;
    return toIssueSnapshot(issue);
  } catch (error) {
    if (input.suppressErrors === false) throw error;
    logger.warn("Linear issue snapshot fetch failed", {
      event: "opencompany.goat_linear_snapshot_failed",
      issue_id: input.issueId,
      error,
    });
    return null;
  }
}

export async function linearGraphqlRequest<T>(input: {
  token: string;
  query: string;
  variables?: Record<string, unknown>;
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
    signal: AbortSignal.timeout(LINEAR_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Linear GraphQL request failed with ${response.status}.`);
  }

  const result = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (result.errors && result.errors.length > 0) {
    throw new Error(`Linear GraphQL returned ${result.errors[0]?.message ?? "an unknown error"}.`);
  }
  if (!result.data) {
    throw new Error("Linear GraphQL returned no data.");
  }
  return result.data;
}

function toIssueSnapshot(issue: Record<string, unknown>): LinearIssueSnapshot | null {
  const issueId = asString(issue.id);
  const title = asString(issue.title);

  const state = asRecord(issue.state);
  const assignee = asRecord(issue.assignee);
  const creator = asRecord(issue.creator);
  const project = asRecord(issue.project);
  const team = asRecord(issue.team);
  const organization = asRecord(team?.organization);
  const organizationId = asString(organization?.id);
  if (!organizationId || !issueId || !title) return null;
  const labels = asRecord(issue.labels);
  const labelNames = Array.isArray(labels?.nodes)
    ? labels.nodes.flatMap((node) => {
        const name = asString(asRecord(node)?.name);
        return name ? [name] : [];
      })
    : [];
  const commentsConnection = asRecord(issue.comments);
  const comments = Array.isArray(commentsConnection?.nodes)
    ? commentsConnection.nodes.flatMap((node) => {
        const record = asRecord(node);
        const id = asString(record?.id);
        const body = asString(record?.body);
        if (!record || !id || !body) return [];
        const user = asRecord(record.user);
        const authorName = asString(user?.name) ?? asString(user?.displayName);
        const createdAt = asString(record.createdAt);
        const url = asString(record.url);
        return [
          {
            id,
            body,
            ...(authorName ? { authorName } : {}),
            ...(createdAt ? { createdAt } : {}),
            ...(url ? { url } : {}),
          },
        ];
      })
    : [];

  const identifier = asString(issue.identifier);
  const url = asString(issue.url);
  const description = asString(issue.description);
  const stateName = asString(state?.name);
  const stateType = asString(state?.type);
  const priority = asString(issue.priorityLabel);
  const assigneeName = asString(assignee?.name) ?? asString(assignee?.displayName);
  const creatorName = asString(creator?.name) ?? asString(creator?.displayName);
  const projectName = asString(project?.name);
  const dueDate = asString(issue.dueDate);
  const createdAt = asString(issue.createdAt);
  const updatedAt = asString(issue.updatedAt);
  const completedAt = asString(issue.completedAt);
  const canceledAt = asString(issue.canceledAt);
  const teamId = asString(team?.id);
  const teamKey = asString(team?.key);
  const teamName = asString(team?.name);
  const organizationUrlKey = asString(organization?.urlKey);

  return {
    organizationId,
    ...(organizationUrlKey ? { organizationUrlKey } : {}),
    issueId,
    ...(identifier ? { identifier } : {}),
    ...(url ? { url } : {}),
    title,
    ...(description ? { description } : {}),
    ...(stateName ? { state: stateName } : {}),
    ...(stateType ? { stateType } : {}),
    ...(priority ? { priority } : {}),
    ...(assigneeName ? { assigneeName } : {}),
    ...(creatorName ? { creatorName } : {}),
    ...(projectName ? { projectName } : {}),
    ...(labelNames.length > 0 ? { labels: labelNames } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(typeof issue.estimate === "number" ? { estimate: issue.estimate } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(canceledAt ? { canceledAt } : {}),
    ...(teamId ? { teamId } : {}),
    ...(teamKey ? { teamKey } : {}),
    ...(teamName ? { teamName } : {}),
    comments,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
