import { describe, expect, test } from "vitest";
import { resolveAgentPath, selectCanonicalAgentRepositoryFiles } from "./paths";

describe("resolveAgentPath", () => {
  test("changes the file path when a title rename changes the slug", () => {
    expect(
      resolveAgentPath({
        title: "New agent",
        currentPath: "agents/old-agent/old-agent.agent",
        existingPaths: ["agents/old-agent/old-agent.agent"],
      }),
    ).toBe("agents/new-agent/new-agent.agent");
  });

  test("keeps the current path when the title still maps to the same slug", () => {
    expect(
      resolveAgentPath({
        title: "Research!",
        currentPath: "agents/research/research.agent",
        existingPaths: ["agents/research/research.agent"],
      }),
    ).toBe("agents/research/research.agent");
  });

  test("chooses the next suffix on collisions while ignoring the current agent", () => {
    expect(
      resolveAgentPath({
        title: "Research",
        currentPath: "agents/old/old.agent",
        existingPaths: [
          "agents/research/research.agent",
          "agents/research-2/research-2.agent",
          "agents/old/old.agent",
        ],
      }),
    ).toBe("agents/research-3/research-3.agent");
  });

  test("treats legacy fixed-file paths as folder slug collisions", () => {
    expect(
      resolveAgentPath({
        title: "Leo",
        existingPaths: ["agents/leo/agent.agent"],
      }),
    ).toBe("agents/leo-2/leo-2.agent");
  });

  test("canonicalizes the current legacy path without suffixing", () => {
    expect(
      resolveAgentPath({
        title: "Leo",
        currentPath: "agents/leo/agent.agent",
        existingPaths: ["agents/leo/agent.agent"],
      }),
    ).toBe("agents/leo/leo.agent");
  });
});

describe("selectCanonicalAgentRepositoryFiles", () => {
  test("canonicalizes legacy agent definition files from GitHub", () => {
    expect(
      selectCanonicalAgentRepositoryFiles([{ path: "agents/leo/agent.agent", sha: "sha_legacy" }]),
    ).toEqual([
      {
        path: "agents/leo/agent.agent",
        canonicalPath: "agents/leo/leo.agent",
        previousPath: "agents/leo/agent.agent",
        legacyPath: "agents/leo/agent.agent",
        sha: "sha_legacy",
      },
    ]);
  });

  test("prefers canonical files while remembering legacy duplicates", () => {
    expect(
      selectCanonicalAgentRepositoryFiles([
        { path: "agents/leo/agent.agent", sha: "sha_legacy" },
        { path: "agents/leo/leo.agent", sha: "sha_canonical" },
      ]),
    ).toEqual([
      {
        path: "agents/leo/leo.agent",
        canonicalPath: "agents/leo/leo.agent",
        previousPath: null,
        legacyPath: "agents/leo/agent.agent",
        sha: "sha_canonical",
      },
    ]);
  });
});
