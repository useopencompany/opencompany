import { describe, expect, it } from "vitest";
import { extractLocalRepositoryPath, hashLocalBridgeToken } from "@/lib/local-codex-utils";

describe("extractLocalRepositoryPath", () => {
  it("extracts absolute paths from quoted and backticked prompts", () => {
    expect(extractLocalRepositoryPath("Use `/Users/ada/project` and inspect it")).toBe(
      "/Users/ada/project",
    );
    expect(extractLocalRepositoryPath('Start Codex on "/Users/ada/My Project"')).toBe(
      "/Users/ada/My Project",
    );
    expect(extractLocalRepositoryPath("Work in '/Users/ada/project/sub dir'")).toBe(
      "/Users/ada/project/sub dir",
    );
  });

  it("extracts unquoted absolute paths and trims trailing punctuation", () => {
    expect(extractLocalRepositoryPath("Use /Users/ada/project, then inspect it")).toBe(
      "/Users/ada/project",
    );
    expect(extractLocalRepositoryPath("Use /Users/ada/project.)")).toBe("/Users/ada/project");
    expect(extractLocalRepositoryPath("Use repo=/Users/ada/project: inspect it")).toBe(
      "/Users/ada/project",
    );
  });

  it("extracts common pasted local path formats", () => {
    expect(extractLocalRepositoryPath("Use “/Users/ada/project” and inspect it")).toBe(
      "/Users/ada/project",
    );
    expect(extractLocalRepositoryPath("Use file:///Users/ada/My%20Project and inspect it")).toBe(
      "/Users/ada/My Project",
    );
    expect(extractLocalRepositoryPath("Use /Users/ada/My\\ Project and inspect it")).toBe(
      "/Users/ada/My Project",
    );
  });

  it("returns null when no absolute path is present", () => {
    expect(extractLocalRepositoryPath("inspect this repo")).toBeNull();
    expect(extractLocalRepositoryPath("Use ./relative/project")).toBeNull();
  });
});

describe("hashLocalBridgeToken", () => {
  it("hashes bridge tokens deterministically without returning the raw token", () => {
    const token = "oc_goat_local_test";
    const hash = hashLocalBridgeToken(token);

    expect(hash).toBe(hashLocalBridgeToken(token));
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64);
  });
});
