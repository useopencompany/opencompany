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
    expect(resolveAmpTargetRepository({ repositories: [web] })).toEqual({
      kind: "attached",
      repository: web,
    });
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
    ).toEqual({ kind: "attached", repository: runner });
    expect(
      resolveAmpTargetRepository({
        repositories: [web, runner],
        requestedRepository: "opencompany-web",
      }),
    ).toEqual({ kind: "attached", repository: web });
  });

  it("throws when the requested repository is not attached", () => {
    expect(() =>
      resolveAmpTargetRepository({
        repositories: [web],
        requestedRepository: "opencompany/missing",
      }),
    ).toThrow(/not attached to this agent/);
  });

  describe("allRepositories (live @github scope)", () => {
    it("resolves a non-attached owner/repo as a workspace target", () => {
      expect(
        resolveAmpTargetRepository({
          repositories: [web],
          requestedRepository: "opencompany/other",
          allRepositories: true,
        }),
      ).toEqual({ kind: "workspace", fullName: "opencompany/other" });
    });

    it("still prefers the attached repository config for attached repos", () => {
      expect(
        resolveAmpTargetRepository({
          repositories: [web],
          requestedRepository: "opencompany/web",
          allRepositories: true,
        }),
      ).toEqual({ kind: "attached", repository: web });
    });

    it("requires the repository argument when nothing is attached", () => {
      expect(() => resolveAmpTargetRepository({ repositories: [], allRepositories: true })).toThrow(
        /needs the repository argument/,
      );
    });

    it("still defaults to the single attached repository without an argument", () => {
      expect(resolveAmpTargetRepository({ repositories: [web], allRepositories: true })).toEqual({
        kind: "attached",
        repository: web,
      });
    });

    it("rejects a requested value that is not owner/repo", () => {
      expect(() =>
        resolveAmpTargetRepository({
          repositories: [],
          requestedRepository: "not-a-repo",
          allRepositories: true,
        }),
      ).toThrow(/not a valid owner\/repo/);
    });
  });
});
