import { getDb } from "@opencompany/db/client";
import { listGoatGitHubIntegrationRepositories } from "@opencompany/db/goat-github";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { and, desc, eq } from "drizzle-orm";
import { getGoatGitHubInstallationToken, githubRequest } from "@/lib/integrations/github";
import type { IntegrationProviderExecutor } from "./dispatcher";
import type { IntegrationToolCard, IntegrationToolField } from "./types";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const MAX_COMMENTS = 20;
const MAX_BODY_CHARS = 4000;
const MAX_COMMENT_CHARS = 1500;
const MAX_REPO_HINTS = 30;

type GitHubAccess = {
  integrationId: string;
  installationId: string;
  repositories: Array<{ id: string; fullName: string; private: boolean }>;
};

// Executes GitHub read tools with the workspace installation token. Connection
// state and the repository allowlist are re-resolved from the database on every
// call: a stale request-time catalog or a guessed repository name never grants
// access.
export function createGitHubIntegrationExecutor(input: {
  workspaceId: string;
  signal?: AbortSignal;
}): IntegrationProviderExecutor {
  return {
    execute: async ({ tool, args }) => {
      const access = await resolveGitHubAccess(input.workspaceId);
      return executeGitHubTool({
        tool,
        args,
        access,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
    inspect: async ({ tool }) => {
      const access = await resolveGitHubAccess(input.workspaceId);
      return {
        inputSchema: jsonSchemaFromFields(tool.fields),
        conventions: [
          "Executed with the workspace's GitHub App installation; only connected repositories are accessible.",
          `Connected repositories: ${formatRepositoryHints(access.repositories)}.`,
        ],
      };
    },
  };
}

async function resolveGitHubAccess(workspaceId: string): Promise<GitHubAccess> {
  const [integration] = await getDb()
    .select({
      id: goatIntegrations.id,
      externalId: goatIntegrations.externalId,
      status: goatIntegrations.status,
    })
    .from(goatIntegrations)
    .where(
      and(eq(goatIntegrations.workspaceId, workspaceId), eq(goatIntegrations.provider, "github")),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!integration || integration.status !== "connected") {
    throw new Error(
      "GitHub is not connected for this workspace. Connect GitHub in Settings → Integrations first.",
    );
  }

  const repositories = await listGoatGitHubIntegrationRepositories(integration.id);
  return {
    integrationId: integration.id,
    installationId: integration.externalId,
    repositories,
  };
}

async function executeGitHubTool(input: {
  tool: IntegrationToolCard;
  args: Record<string, unknown>;
  access: GitHubAccess;
  signal?: AbortSignal;
}): Promise<unknown> {
  const { tool, args, access, signal } = input;

  if (tool.name === "list_repositories") {
    return {
      repositories: access.repositories.map((repository) => ({
        fullName: repository.fullName,
        private: repository.private,
      })),
    };
  }

  const repository = resolveRepository(access, args.repository);
  const token = await getGoatGitHubInstallationToken(access.installationId);
  const get = <T>(path: string) =>
    githubRequest<T>({ token, path, method: "GET", ...(signal ? { signal } : {}) });
  const limit = readLimit(args.limit);
  const state = readState(args.state);

  switch (tool.name) {
    case "list_issues": {
      const labels =
        typeof args.labels === "string" && args.labels.trim() ? args.labels.trim() : null;
      const issues = await get<GitHubIssue[]>(
        `/repos/${repository}/issues?state=${state}&per_page=${limit}${
          labels ? `&labels=${encodeURIComponent(labels)}` : ""
        }`,
      );
      return {
        repository,
        issues: issues
          .filter((issue) => !issue.pull_request)
          .map((issue) => compactIssueSummary(issue)),
      };
    }
    case "get_issue": {
      const number = readIssueNumber(args.number);
      const [issue, comments] = await Promise.all([
        get<GitHubIssue>(`/repos/${repository}/issues/${number}`),
        get<GitHubComment[]>(
          `/repos/${repository}/issues/${number}/comments?per_page=${MAX_COMMENTS}`,
        ),
      ]);
      return {
        repository,
        issue: {
          ...compactIssueSummary(issue),
          body: truncateText(issue.body, MAX_BODY_CHARS),
        },
        comments: comments.map((comment) => compactComment(comment)),
      };
    }
    case "list_pull_requests": {
      const pulls = await get<GitHubPullRequest[]>(
        `/repos/${repository}/pulls?state=${state}&per_page=${limit}`,
      );
      return {
        repository,
        pullRequests: pulls.map((pull) => compactPullSummary(pull)),
      };
    }
    case "get_pull_request": {
      const number = readIssueNumber(args.number);
      const [pull, reviews, comments] = await Promise.all([
        get<GitHubPullRequest>(`/repos/${repository}/pulls/${number}`),
        get<GitHubReview[]>(
          `/repos/${repository}/pulls/${number}/reviews?per_page=${MAX_COMMENTS}`,
        ),
        get<GitHubComment[]>(
          `/repos/${repository}/issues/${number}/comments?per_page=${MAX_COMMENTS}`,
        ),
      ]);
      return {
        repository,
        pullRequest: {
          ...compactPullSummary(pull),
          body: truncateText(pull.body, MAX_BODY_CHARS),
          merged: pull.merged ?? false,
          additions: pull.additions,
          deletions: pull.deletions,
          changedFiles: pull.changed_files,
        },
        reviews: reviews.map((review) => ({
          author: review.user?.login ?? null,
          state: review.state,
          submittedAt: review.submitted_at ?? null,
          body: truncateText(review.body, MAX_COMMENT_CHARS),
        })),
        comments: comments.map((comment) => compactComment(comment)),
      };
    }
    default:
      throw new Error(`Unsupported GitHub tool "${tool.name}".`);
  }
}

function resolveRepository(access: GitHubAccess, value: unknown) {
  const requested = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = access.repositories.find(
    (repository) => repository.fullName.toLowerCase() === requested,
  );
  if (!match) {
    throw new Error(
      `Repository ${JSON.stringify(typeof value === "string" ? value : "")} is not connected to this workspace. Connected repositories: ${formatRepositoryHints(access.repositories)}.`,
    );
  }
  return match.fullName;
}

function formatRepositoryHints(repositories: GitHubAccess["repositories"]) {
  if (repositories.length === 0) return "none";
  const names = repositories.slice(0, MAX_REPO_HINTS).map((repository) => repository.fullName);
  const suffix = repositories.length > MAX_REPO_HINTS ? `, … (${repositories.length} total)` : "";
  return `${names.join(", ")}${suffix}`;
}

function readLimit(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(1, Math.floor(value)), MAX_LIST_LIMIT);
}

function readState(value: unknown): "open" | "closed" | "all" {
  return value === "closed" || value === "all" ? value : "open";
}

function readIssueNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error('Argument "number" must be a positive integer.');
  }
  return value;
}

function truncateText(value: string | null | undefined, maxChars: number) {
  if (!value) return null;
  return value.length > maxChars ? `${value.slice(0, maxChars)}… [truncated]` : value;
}

function jsonSchemaFromFields(fields: readonly IntegrationToolField[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      fields.map((field) => [
        field.name,
        {
          type: field.type,
          ...(field.description ? { description: field.description } : {}),
          ...(field.enumValues?.length ? { enum: [...field.enumValues] } : {}),
        },
      ]),
    ),
    required: fields.filter((field) => field.required).map((field) => field.name),
  };
}

type GitHubUser = { login?: string };

type GitHubIssue = {
  number: number;
  title: string;
  state: string;
  user?: GitHubUser | null;
  labels?: Array<{ name?: string } | string>;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  body?: string | null;
  pull_request?: unknown;
};

type GitHubPullRequest = {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  user?: GitHubUser | null;
  head?: { ref?: string };
  base?: { ref?: string };
  created_at?: string;
  updated_at?: string;
  html_url?: string;
  body?: string | null;
  merged?: boolean;
  additions?: number;
  deletions?: number;
  changed_files?: number;
};

type GitHubComment = {
  user?: GitHubUser | null;
  created_at?: string;
  body?: string | null;
};

type GitHubReview = {
  user?: GitHubUser | null;
  state?: string;
  submitted_at?: string | null;
  body?: string | null;
};

function compactIssueSummary(issue: GitHubIssue) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.user?.login ?? null,
    labels: (issue.labels ?? [])
      .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
      .filter(Boolean),
    comments: issue.comments ?? 0,
    createdAt: issue.created_at ?? null,
    updatedAt: issue.updated_at ?? null,
    url: issue.html_url ?? null,
  };
}

function compactPullSummary(pull: GitHubPullRequest) {
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft ?? false,
    author: pull.user?.login ?? null,
    headRef: pull.head?.ref ?? null,
    baseRef: pull.base?.ref ?? null,
    createdAt: pull.created_at ?? null,
    updatedAt: pull.updated_at ?? null,
    url: pull.html_url ?? null,
  };
}

function compactComment(comment: GitHubComment) {
  return {
    author: comment.user?.login ?? null,
    createdAt: comment.created_at ?? null,
    body: truncateText(comment.body, MAX_COMMENT_CHARS),
  };
}
