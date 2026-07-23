import {
  GoatActionAuthError,
  GoatActionInvalidParamsError,
  type GoatActionProviderCatalog,
  optionalNumberParam,
  optionalStringParam,
  truncateText,
} from "@/lib/actions/types";
import {
  GoatGitHubApiError,
  type GoatGitHubConnectedInstallation,
  listConnectedGoatGitHubInstallations,
  searchGoatGitHubIssues,
} from "@/lib/integrations/github";

const DEFAULT_SEARCH_RESULTS = 10;
const MAX_SEARCH_RESULTS = 15;
const MAX_QUERY_CHARS = 512;
const MAX_TITLE_CHARS = 300;
const MAX_BODY_CHARS = 500;
const MAX_LABELS = 10;
const MAX_ASSIGNEES = 5;
const MAX_COMPACT_STRING_CHARS = 100;
const MAX_REPOSITORY_CHARS = 200;
const MAX_URL_CHARS = 500;

export async function resolveGitHubActions(
  workspaceId: string,
): Promise<GoatActionProviderCatalog | null> {
  const connections = await listConnectedGoatGitHubInstallations(workspaceId);
  if (connections.length === 0) return null;

  const accountParam =
    connections.length > 1
      ? {
          account: {
            type: "string" as const,
            description: `Which connected GitHub account to search. One of: ${connections
              .map((connection) => JSON.stringify(connectionSelector(connection, connections)))
              .join(", ")}.`,
          },
        }
      : {};

  return {
    id: "github",
    label:
      connections.length === 1
        ? `GitHub (${connectionLabel(connections[0]!)})`
        : `GitHub (${connections.length} accounts)`,
    description: "Search issues and pull requests in connected repositories.",
    actions: [
      {
        id: "github.search_issues",
        provider: "github",
        capability: "read",
        permissionMode: "on",
        description:
          "Search GitHub issues and pull requests visible to the connected installation. Supports GitHub qualifiers such as repo:owner/name, org:name, is:issue, is:pr, state:open, author:, assignee:, and label:. Returns compact matches with links and body previews.",
        params: {
          type: "object",
          additionalProperties: false,
          required: connections.length > 1 ? ["query", "account"] : ["query"],
          properties: {
            query: {
              type: "string",
              minLength: 1,
              maxLength: MAX_QUERY_CHARS,
              description: "GitHub issue search query, including any useful qualifiers.",
            },
            limit: {
              type: "number",
              minimum: 1,
              maximum: MAX_SEARCH_RESULTS,
              description: `Maximum matches to return (default ${DEFAULT_SEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS}).`,
            },
            ...accountParam,
          },
        },
        execute: async (params, context) => {
          validateKeys(params, connections.length > 1);
          const connection = resolveConnection(connections, optionalStringParam(params, "account"));
          const query = requiredSearchQuery(params);
          const limit = searchLimit(params);

          try {
            const response = await searchGoatGitHubIssues({
              installationId: connection.installationId,
              query,
              limit,
              signal: context.signal,
            });
            return {
              account: connectionLabel(connection),
              query,
              ...compactSearchResponse(response, limit),
            };
          } catch (error) {
            if (
              error instanceof GoatGitHubApiError &&
              (error.status === 401 ||
                error.status === 404 ||
                (error.status === 403 && error.operation === "installation_token"))
            ) {
              throw new GoatActionAuthError(
                "auth_expired",
                "github",
                `The GitHub installation for ${connectionLabel(connection)} is no longer usable; reconnect GitHub in Settings → Integrations, then retry.`,
              );
            }
            throw error;
          }
        },
      },
    ],
  };
}

function validateKeys(params: Record<string, unknown>, hasMultipleAccounts: boolean) {
  const allowed = new Set(hasMultipleAccounts ? ["query", "limit", "account"] : ["query", "limit"]);
  const unexpected = Object.keys(params).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new GoatActionInvalidParamsError(`Unexpected parameter ${JSON.stringify(unexpected)}.`);
  }
}

function requiredSearchQuery(params: Record<string, unknown>) {
  const value = params.query;
  if (typeof value !== "string" || !value.trim()) {
    throw new GoatActionInvalidParamsError('"query" is required and must be a non-empty string.');
  }
  const query = value.trim();
  if (query.length > MAX_QUERY_CHARS) {
    throw new GoatActionInvalidParamsError(
      `"query" must be at most ${MAX_QUERY_CHARS} characters.`,
    );
  }
  return query;
}

function searchLimit(params: Record<string, unknown>) {
  const value = optionalNumberParam(params, "limit");
  if (value === undefined) return DEFAULT_SEARCH_RESULTS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_SEARCH_RESULTS) {
    throw new GoatActionInvalidParamsError(
      `"limit" must be an integer from 1 to ${MAX_SEARCH_RESULTS}.`,
    );
  }
  return value;
}

function resolveConnection(
  connections: readonly GoatGitHubConnectedInstallation[],
  account: string | undefined,
) {
  if (account) {
    const wanted = account.toLowerCase();
    const match = connections.find(
      (connection) => connectionSelector(connection, connections).toLowerCase() === wanted,
    );
    if (!match) {
      throw new GoatActionInvalidParamsError(
        `No connected GitHub account matches ${JSON.stringify(account)}. Connected accounts: ${connections
          .map((connection) => JSON.stringify(connectionSelector(connection, connections)))
          .join(", ")}.`,
      );
    }
    return match;
  }
  if (connections.length === 1) return connections[0]!;
  throw new GoatActionInvalidParamsError(
    `Multiple GitHub accounts are connected; pass account as one of: ${connections
      .map((connection) => JSON.stringify(connectionSelector(connection, connections)))
      .join(", ")}.`,
  );
}

function connectionLabel(connection: GoatGitHubConnectedInstallation) {
  const label =
    connection.accountName?.trim() || `GitHub installation ${connection.installationId}`;
  const normalized = label.replace(/\s+/g, " ");
  return normalized.length > 100 ? `${normalized.slice(0, 100)}…` : normalized;
}

function connectionSelector(
  connection: GoatGitHubConnectedInstallation,
  connections: readonly GoatGitHubConnectedInstallation[],
) {
  const label = connectionLabel(connection);
  const duplicates = connections.filter(
    (candidate) => connectionLabel(candidate).toLowerCase() === label.toLowerCase(),
  );
  return duplicates.length === 1 ? label : connection.installationId;
}

function compactSearchResponse(value: unknown, limit: number) {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error("GitHub returned an invalid search response.");
  }

  return {
    totalCount: finiteNonNegativeInteger(value.total_count) ?? value.items.length,
    incompleteResults: value.incomplete_results === true,
    items: value.items.slice(0, limit).flatMap((item) => {
      if (!isRecord(item)) return [];
      const number = finiteNonNegativeInteger(item.number);
      const title = stringValue(item.title);
      if (number === undefined || !title) return [];

      const pullRequest = isRecord(item.pull_request);
      return [
        {
          repository: repositoryName(item.repository_url),
          number,
          type: pullRequest ? "pull_request" : "issue",
          title: truncateText(title, MAX_TITLE_CHARS),
          state: truncateText(stringValue(item.state), MAX_COMPACT_STRING_CHARS),
          draft: pullRequest && typeof item.draft === "boolean" ? item.draft : undefined,
          author: isRecord(item.user)
            ? truncateText(stringValue(item.user.login), MAX_COMPACT_STRING_CHARS)
            : undefined,
          assignees: Array.isArray(item.assignees)
            ? item.assignees
                .slice(0, MAX_ASSIGNEES)
                .flatMap((assignee) =>
                  isRecord(assignee) && stringValue(assignee.login)
                    ? [truncateText(stringValue(assignee.login), MAX_COMPACT_STRING_CHARS)!]
                    : [],
                )
            : [],
          labels: Array.isArray(item.labels)
            ? item.labels
                .slice(0, MAX_LABELS)
                .flatMap((label) =>
                  isRecord(label) && stringValue(label.name)
                    ? [truncateText(stringValue(label.name), MAX_COMPACT_STRING_CHARS)!]
                    : [],
                )
            : [],
          updatedAt: truncateText(stringValue(item.updated_at), 40),
          bodyPreview: truncateText(stringValue(item.body), MAX_BODY_CHARS),
          url: githubWebUrl(item.html_url),
        },
      ];
    }),
  };
}

function repositoryName(value: unknown) {
  const url = safeUrl(value);
  if (!url || url.protocol !== "https:" || url.hostname !== "api.github.com") return undefined;
  const match = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname);
  const repository = match?.[1];
  return repository && repository.length <= MAX_REPOSITORY_CHARS ? repository : undefined;
}

function githubWebUrl(value: unknown) {
  const url = safeUrl(value);
  if (!url || url.protocol !== "https:" || url.hostname !== "github.com") return undefined;
  const normalized = url.toString();
  return normalized.length <= MAX_URL_CHARS ? normalized : undefined;
}

function safeUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function finiteNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
