import { describe, expect, it } from "vitest";
import { normalizeGitHubPullRequestSearchFilters } from "@/lib/kpis/providers/github";

describe("normalizeGitHubPullRequestSearchFilters", () => {
  it("normalizes whitespace and detects merged PR searches", () => {
    expect(normalizeGitHubPullRequestSearchFilters("  is:merged   author:octocat  ")).toEqual({
      value: "is:merged author:octocat",
      hasMergedQualifier: true,
    });
  });

  it("allows non-merged pull request filters", () => {
    expect(normalizeGitHubPullRequestSearchFilters("author:octocat label:bug")).toEqual({
      value: "author:octocat label:bug",
      hasMergedQualifier: false,
    });
  });

  it("rejects repository scoping controlled by the platform", () => {
    expect(() => normalizeGitHubPullRequestSearchFilters("is:merged repo:octo/repo")).toThrow(
      "Repository and organization scope are managed by the KPI connection.",
    );
  });

  it("rejects date scoping controlled by the card", () => {
    expect(() => normalizeGitHubPullRequestSearchFilters("is:merged merged:>=2026-01-01")).toThrow(
      "Date filters are managed by the KPI card time range.",
    );
  });

  it("rejects issue searches", () => {
    expect(() => normalizeGitHubPullRequestSearchFilters("is:issue author:octocat")).toThrow(
      "This KPI only supports pull request searches.",
    );
  });
});
