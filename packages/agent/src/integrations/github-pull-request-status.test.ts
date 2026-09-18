import { describe, expect, it } from "vitest";
import {
  GitHubPullRequestStatusError,
  type PullRequestStatusQuery,
  parsePullRequestStatuses,
} from "./github-pull-request-status";

const queries: PullRequestStatusQuery[] = [
  { id: "link-1", repository: "acme/web", number: 7 },
  { id: "link-2", repository: "acme/api", number: 9 },
];

function pullRequest(fields: Record<string, unknown>, rollup?: string | null) {
  return {
    merged: false,
    closed: false,
    isDraft: false,
    mergeStateStatus: "CLEAN",
    commits: { nodes: [{ commit: { statusCheckRollup: rollup ? { state: rollup } : null } }] },
    ...fields,
  };
}

describe("parsePullRequestStatuses", () => {
  it("maps each aliased field back to the query that asked for it", () => {
    const parsed = parsePullRequestStatuses(
      {
        data: {
          pr0: { pullRequest: pullRequest({ merged: true }) },
          pr1: { pullRequest: pullRequest({}, "FAILURE") },
        },
      },
      queries,
    );
    expect(parsed).toEqual([
      { id: "link-1", found: true, state: "merged" },
      { id: "link-2", found: true, state: "blocked" },
    ]);
  });

  it("reports a PR the token cannot see as not found", () => {
    const parsed = parsePullRequestStatuses(
      { data: { pr0: null, pr1: { pullRequest: null } } },
      queries,
    );
    expect(parsed).toEqual([
      { id: "link-1", found: false },
      { id: "link-2", found: false },
    ]);
  });

  it("keeps the statuses that did resolve when another repository errors", () => {
    const parsed = parsePullRequestStatuses(
      {
        data: { pr0: { pullRequest: pullRequest({}) }, pr1: null },
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
      },
      queries,
    );
    expect(parsed).toEqual([
      { id: "link-1", found: true, state: "open" },
      { id: "link-2", found: false },
    ]);
  });

  it("treats a PR with no CI configured as open rather than failing", () => {
    const parsed = parsePullRequestStatuses(
      { data: { pr0: { pullRequest: pullRequest({}, null) }, pr1: null } },
      queries,
    );
    expect(parsed[0]).toEqual({ id: "link-1", found: true, state: "open" });
  });

  it("reports a draft PR as draft", () => {
    const parsed = parsePullRequestStatuses(
      { data: { pr0: { pullRequest: pullRequest({ isDraft: true, mergeStateStatus: "DRAFT" }) } } },
      [queries[0]!],
    );
    expect(parsed[0]).toEqual({ id: "link-1", found: true, state: "draft" });
  });

  it("rejects a response with no data at all", () => {
    expect(() =>
      parsePullRequestStatuses({ errors: [{ message: "Bad credentials" }] }, queries),
    ).toThrow(GitHubPullRequestStatusError);
  });
});
