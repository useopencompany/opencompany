import { describe, expect, it } from "vitest";
import {
  gitHubEnabledEventTypes,
  gitHubSelectedRepoIds,
  parseGitHubBrainSourceConfig,
  parseGitHubWikiSourceConfig,
} from "./github";

describe("opencompany GitHub source config", () => {
  it("keeps the brain config's missing-events compatibility behavior", () => {
    const config = parseGitHubBrainSourceConfig({
      repos: [{ id: "4242", fullName: "acme/api" }],
    });

    expect(gitHubSelectedRepoIds(config)).toEqual(new Set(["4242"]));
    expect(gitHubEnabledEventTypes(config)).toContain("issue_opened");
    expect(gitHubEnabledEventTypes(config)).toContain("pull_request_merged");
  });

  it("parses wiki repository scope and drops malformed values", () => {
    expect(
      parseGitHubWikiSourceConfig({
        repos: [
          { id: " 4242 ", fullName: " acme/api " },
          { id: "", fullName: "dropped/repo" },
        ],
        events: ["issue_opened", "unknown", "issue_opened"],
      }),
    ).toEqual({
      repos: [{ id: "4242", fullName: "acme/api" }],
      events: ["issue_opened"],
    });
  });

  it("preserves an explicit empty wiki event selection", () => {
    const config = parseGitHubWikiSourceConfig({
      repos: [{ id: "4242", fullName: "acme/api" }],
      events: [],
    });

    expect(gitHubEnabledEventTypes(config)).toEqual(new Set());
  });
});
