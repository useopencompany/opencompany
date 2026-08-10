import { describe, expect, it } from "vitest";
import { extractGitHubPullRequestUrl } from "@/lib/pull-request-link";

describe("extractGitHubPullRequestUrl", () => {
  it("finds a PR URL mentioned in free-text task output", () => {
    const result = [
      "Recovered and inspected the current state. The work is already finished and merged.",
      "",
      "PR: https://github.com/useopencompany/opencompany-experimental/pull/1011",
      "Merge commit: `894576e3` on `main`",
    ].join("\n");

    expect(extractGitHubPullRequestUrl(result)).toBe(
      "https://github.com/useopencompany/opencompany-experimental/pull/1011",
    );
  });

  it("checks later texts when earlier ones have no match", () => {
    expect(
      extractGitHubPullRequestUrl(
        "no link here",
        "see https://github.com/acme/widgets/pull/42 for details",
      ),
    ).toBe("https://github.com/acme/widgets/pull/42");
  });

  it("returns null when nothing matches", () => {
    expect(extractGitHubPullRequestUrl("done, no PR needed", null, undefined)).toBeNull();
  });

  it("ignores non-pull-request GitHub links", () => {
    expect(
      extractGitHubPullRequestUrl(
        "repo: https://github.com/useopencompany/opencompany-experimental",
      ),
    ).toBeNull();
  });
});
