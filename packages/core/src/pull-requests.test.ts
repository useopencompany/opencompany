import { describe, expect, it } from "vitest";
import {
  derivePullRequestState,
  findPullRequestRefs,
  findReportedPullRequestRef,
  isPullRequestCreationTool,
  isTerminalPullRequestState,
} from "./pull-requests";

describe("findPullRequestRefs", () => {
  it("reads owner, repo, and number out of a PR URL", () => {
    expect(
      findPullRequestRefs("Opened https://github.com/useopencompany/opencompany/pull/1620"),
    ).toEqual([
      {
        repository: "useopencompany/opencompany",
        number: 1620,
        url: "https://github.com/useopencompany/opencompany/pull/1620",
      },
    ]);
  });

  it("collapses the same PR mentioned several times in one turn", () => {
    const text = [
      "https://github.com/acme/web/pull/7",
      "see https://github.com/acme/web/pull/7 for the diff",
      "https://github.com/ACME/web/pull/7",
    ].join("\n");
    expect(findPullRequestRefs(text)).toHaveLength(1);
  });

  it("keeps distinct PRs in first-seen order", () => {
    const refs = findPullRequestRefs(
      "https://github.com/acme/web/pull/9 then https://github.com/acme/api/pull/2",
    );
    expect(refs.map((ref) => `${ref.repository}#${ref.number}`)).toEqual([
      "acme/web#9",
      "acme/api#2",
    ]);
  });

  it("accepts dots, dashes and underscores in owner and repo names", () => {
    expect(
      findPullRequestRefs("https://github.com/my-org/some.repo_v2/pull/3")[0]?.repository,
    ).toBe("my-org/some.repo_v2");
  });

  it("normalizes a URL carrying a suffix like /files", () => {
    expect(findPullRequestRefs("https://github.com/acme/web/pull/12/files")[0]?.url).toBe(
      "https://github.com/acme/web/pull/12",
    );
  });

  it("ignores an issue URL, a bare PR number, and /pull/0", () => {
    expect(findPullRequestRefs("https://github.com/acme/web/issues/12")).toEqual([]);
    expect(findPullRequestRefs("fixed in #1620")).toEqual([]);
    expect(findPullRequestRefs("https://github.com/acme/web/pull/0")).toEqual([]);
  });
});

describe("findReportedPullRequestRef", () => {
  it("takes the first PR a Task reports, so every surface shows the same one", () => {
    const result = [
      "Opened https://github.com/acme/web/pull/42 with the fix.",
      "Follows the approach in https://github.com/acme/web/pull/7.",
    ].join("\n");

    expect(findReportedPullRequestRef(result)?.number).toBe(42);
  });

  it("falls through to later texts when an earlier one reports nothing", () => {
    expect(findReportedPullRequestRef(null, "", "see https://github.com/acme/web/pull/9")).toEqual({
      repository: "acme/web",
      number: 9,
      url: "https://github.com/acme/web/pull/9",
    });
  });

  it("reports nothing when no text names a pull request", () => {
    expect(findReportedPullRequestRef("nothing to ship", undefined)).toBeNull();
  });
});

describe("isPullRequestCreationTool", () => {
  it("matches the hosted tool and its namespaced aliases", () => {
    expect(isPullRequestCreationTool("create_pull_request")).toBe(true);
    expect(isPullRequestCreationTool("github__create_pull_request")).toBe(true);
    expect(isPullRequestCreationTool("mcp__github__create_pull_request")).toBe(true);
  });

  it("does not match reads or merges of a pull request", () => {
    expect(isPullRequestCreationTool("list_pull_requests")).toBe(false);
    expect(isPullRequestCreationTool("merge_pull_request")).toBe(false);
    expect(isPullRequestCreationTool(null)).toBe(false);
  });
});

describe("derivePullRequestState", () => {
  const base = { merged: false, closed: false, isDraft: false } as const;

  it("reports merged ahead of every other signal", () => {
    expect(
      derivePullRequestState({
        ...base,
        merged: true,
        closed: true,
        isDraft: true,
        checksState: "FAILURE",
        mergeStateStatus: "DIRTY",
      }),
    ).toBe("merged");
  });

  it("reports a closed unmerged PR as closed", () => {
    expect(derivePullRequestState({ ...base, closed: true, checksState: "FAILURE" })).toBe(
      "closed",
    );
  });

  it("reports failing and errored checks as blocked", () => {
    expect(derivePullRequestState({ ...base, checksState: "FAILURE" })).toBe("blocked");
    expect(derivePullRequestState({ ...base, checksState: "ERROR" })).toBe("blocked");
  });

  it("reports a blocked or conflicted merge state as blocked", () => {
    expect(derivePullRequestState({ ...base, mergeStateStatus: "BLOCKED" })).toBe("blocked");
    expect(derivePullRequestState({ ...base, mergeStateStatus: "DIRTY" })).toBe("blocked");
  });

  it("leaves a PR that is merely behind or still computing as open", () => {
    expect(derivePullRequestState({ ...base, mergeStateStatus: "BEHIND" })).toBe("open");
    expect(derivePullRequestState({ ...base, mergeStateStatus: "UNKNOWN" })).toBe("open");
    expect(derivePullRequestState({ ...base, checksState: "PENDING" })).toBe("open");
  });

  it("keeps a draft out of ready-to-merge green, but still shows a red draft as blocked", () => {
    expect(derivePullRequestState({ ...base, isDraft: true })).toBe("draft");
    expect(derivePullRequestState({ ...base, isDraft: true, checksState: "FAILURE" })).toBe(
      "blocked",
    );
  });
});

describe("isTerminalPullRequestState", () => {
  it("treats merged and closed as settled, and everything else as worth re-reading", () => {
    expect(isTerminalPullRequestState("merged")).toBe(true);
    expect(isTerminalPullRequestState("closed")).toBe(true);
    expect(isTerminalPullRequestState("open")).toBe(false);
    expect(isTerminalPullRequestState("blocked")).toBe(false);
    expect(isTerminalPullRequestState("draft")).toBe(false);
  });
});
