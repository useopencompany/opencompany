import { derivePullRequestState, type PullRequestState } from "@opencompany/core";

/**
 * Reads the current state of linked pull requests from GitHub.
 *
 * One GraphQL request covers every PR the caller asked about. That matters because the sidebar
 * asks about all of a user's linked PRs at once, and the REST equivalent would be one round trip
 * per PR plus another for each PR's check runs.
 */

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

export type PullRequestStatusQuery = {
  /** Echoed back on the result so the caller can match it to its own row. */
  id: string;
  repository: string;
  number: number;
};

export type PullRequestStatusResult =
  | { id: string; found: true; state: PullRequestState }
  /** GitHub answered, and this PR is not something the token can see. */
  | { id: string; found: false };

export class GitHubPullRequestStatusError extends Error {}

export async function readPullRequestStatuses(input: {
  accessToken: string;
  queries: readonly PullRequestStatusQuery[];
  signal?: AbortSignal;
}): Promise<PullRequestStatusResult[]> {
  if (input.queries.length === 0) return [];

  // Aliased per PR so one document can ask about many. Aliases are positional (`pr0`, `pr1`, …)
  // rather than derived from the caller's ids, because a GraphQL alias must be a valid name and
  // our ids are not.
  const fields = input.queries
    .map((query, index) => {
      const [owner, name] = splitRepository(query.repository);
      return `  pr${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    pullRequest(number: ${query.number}) { ...prState }
  }`;
    })
    .join("\n");

  const document = `fragment prState on PullRequest {
  merged
  closed
  isDraft
  mergeStateStatus
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
query SessionPullRequestStatuses {
${fields}
}`;

  const response = await fetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github.merge-info-preview+json",
      Authorization: `Bearer ${input.accessToken}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ query: document }),
    signal: input.signal ?? null,
  });
  if (!response.ok) {
    throw new GitHubPullRequestStatusError(
      `GitHub pull request status query failed with ${response.status}.`,
    );
  }

  const payload = (await response.json()) as unknown;
  return parsePullRequestStatuses(payload, input.queries);
}

/**
 * Turns one GraphQL response into a result per query.
 *
 * GitHub reports a PR the token cannot see as a `null` field plus a top-level error, and still
 * returns 200 with the other PRs resolved. So a null field means "not found for this caller", and
 * a top-level `errors` array is only fatal when *nothing* resolved — otherwise one inaccessible
 * repository would discard the statuses of every other PR in the batch.
 */
export function parsePullRequestStatuses(
  payload: unknown,
  queries: readonly PullRequestStatusQuery[],
): PullRequestStatusResult[] {
  const body = asRecord(payload);
  const data = asRecord(body?.data);
  if (!data) {
    throw new GitHubPullRequestStatusError("GitHub returned no pull request status data.");
  }

  return queries.map((query, index) => {
    const pullRequest = asRecord(asRecord(data[`pr${index}`])?.pullRequest);
    if (!pullRequest) return { id: query.id, found: false };
    return {
      id: query.id,
      found: true,
      state: derivePullRequestState({
        merged: pullRequest.merged === true,
        closed: pullRequest.closed === true,
        isDraft: pullRequest.isDraft === true,
        checksState: readChecksState(pullRequest),
        mergeStateStatus: readMergeStateStatus(pullRequest),
      }),
    };
  });
}

function readChecksState(pullRequest: Record<string, unknown>) {
  const nodes = asRecord(pullRequest.commits)?.nodes;
  const commit = Array.isArray(nodes) ? asRecord(asRecord(nodes[0])?.commit) : null;
  const state = asRecord(commit?.statusCheckRollup)?.state;
  // A PR with no CI configured has no rollup at all, which is not the same as a passing one;
  // `derivePullRequestState` treats both as "nothing to report" and falls through to open.
  return typeof state === "string"
    ? (state as "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED")
    : null;
}

function readMergeStateStatus(pullRequest: Record<string, unknown>) {
  const status = pullRequest.mergeStateStatus;
  return typeof status === "string"
    ? (status as
        | "BEHIND"
        | "BLOCKED"
        | "CLEAN"
        | "DIRTY"
        | "DRAFT"
        | "HAS_HOOKS"
        | "UNKNOWN"
        | "UNSTABLE")
    : null;
}

function splitRepository(repository: string): [string, string] {
  const separator = repository.indexOf("/");
  if (separator <= 0 || separator === repository.length - 1) {
    throw new GitHubPullRequestStatusError(`"${repository}" is not an owner/repo pair.`);
  }
  return [repository.slice(0, separator), repository.slice(separator + 1)];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
