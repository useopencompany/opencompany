import { describe, expect, it } from "vitest";
import { parseGitHubCliArgs } from "./github-cli";

describe("parseGitHubCliArgs", () => {
  it("splits plain whitespace-separated tokens", () => {
    expect(parseGitHubCliArgs("pr view 301 --json number,title")).toEqual([
      "pr",
      "view",
      "301",
      "--json",
      "number,title",
    ]);
  });

  it("keeps quoted segments as single tokens", () => {
    expect(parseGitHubCliArgs("api graphql -f query='query { viewer { login } }'")).toEqual([
      "api",
      "graphql",
      "-f",
      "query=query { viewer { login } }",
    ]);
    expect(parseGitHubCliArgs('issue create --title "a b" --body c')).toEqual([
      "issue",
      "create",
      "--title",
      "a b",
      "--body",
      "c",
    ]);
  });

  it("honors backslash escapes", () => {
    expect(parseGitHubCliArgs("echo a\\ b")).toEqual(["echo", "a b"]);
    expect(parseGitHubCliArgs('echo \\"x\\"')).toEqual(["echo", '"x"']);
  });

  it("returns null for non-strings and unterminated quotes or escapes", () => {
    expect(parseGitHubCliArgs(undefined)).toBeNull();
    expect(parseGitHubCliArgs(42)).toBeNull();
    expect(parseGitHubCliArgs("pr view 'unterminated")).toBeNull();
    expect(parseGitHubCliArgs("trailing escape\\")).toBeNull();
  });

  it("returns an empty argv for an empty string", () => {
    expect(parseGitHubCliArgs("")).toEqual([]);
  });
});
