import type { AgentGitHubRepositoryConfig } from "@opencompany/agent-runtime/types";
import { describe, expect, it } from "vitest";
import { resolveAmpTargetRepository } from "./amp-tool";

const web: AgentGitHubRepositoryConfig = {
  id: "opencompany-web",
  fullName: "opencompany/web",
  defaultBranch: "main",
};
const runner: AgentGitHubRepositoryConfig = {
  id: "opencompany-runner",
  fullName: "opencompany/runner",
  defaultBranch: "develop",
};

describe("resolveAmpTargetRepository", () => {
  it("throws when no repository is attached", () => {
    expect(() => resolveAmpTargetRepository({ repositories: [] })).toThrow(
      /at least one GitHub repository/,
    );
  });

  it("uses the single attached repository without an explicit argument", () => {
    expect(resolveAmpTargetRepository({ repositories: [web] })).toBe(web);
  });

  it("requires an explicit repository argument when more than one is attached", () => {
    expect(() => resolveAmpTargetRepository({ repositories: [web, runner] })).toThrow(
      /More than one repository is attached/,
    );
  });

  it("matches the requested repository by full name or id", () => {
    expect(
      resolveAmpTargetRepository({
        repositories: [web, runner],
        requestedRepository: "opencompany/runner",
      }),
    ).toBe(runner);
    expect(
      resolveAmpTargetRepository({
        repositories: [web, runner],
        requestedRepository: "opencompany-web",
      }),
    ).toBe(web);
  });

  it("throws when the requested repository is not attached", () => {
    expect(() =>
      resolveAmpTargetRepository({
        repositories: [web],
        requestedRepository: "opencompany/missing",
      }),
    ).toThrow(/not attached to this agent/);
  });
});
