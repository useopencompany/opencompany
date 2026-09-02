import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({ loadGitHubUserAuthForUser: vi.fn() }));
const githubMocks = vi.hoisted(() => ({ listGitHubUserRepositoryNames: vi.fn() }));
const dbMocks = vi.hoisted(() => ({ rows: [] as unknown[][] }));

vi.mock("./coding-agent-shared", () => ({
  loadGitHubUserAuthForUser: authMocks.loadGitHubUserAuthForUser,
}));

vi.mock("./github", () => ({
  listGitHubUserRepositoryNames: githubMocks.listGitHubUserRepositoryNames,
}));

vi.mock("./db", () => ({ getDb: () => queryBuilder() }));

import {
  getAvailableGitHubRepositoryNamesForRunner,
  getAvailableHarnessToolsForRunner,
} from "./harness-planner";

describe("runner GitHub planning context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.rows.length = 0;
    authMocks.loadGitHubUserAuthForUser.mockResolvedValue(null);
    githubMocks.listGitHubUserRepositoryNames.mockResolvedValue([]);
  });

  it("enables the coding GitHub tools for a personal connection", async () => {
    dbMocks.rows.push([{ provider: "github_user" }]);

    await expect(getAvailableHarnessToolsForRunner("user_1")).resolves.toEqual(
      expect.arrayContaining([
        "github_clone_repository",
        "github_shell",
        "github_status",
        "github_open_pull_request",
      ]),
    );
  });

  it("merges live personal repositories with legacy workspace resources", async () => {
    dbMocks.rows.push([
      { name: "opencompany/app" },
      { name: "opencompany/shared" },
      { name: "opencompany/app" },
    ]);
    authMocks.loadGitHubUserAuthForUser.mockResolvedValue({
      githubToken: "ghu_personal",
      githubAuthHeader: "Authorization: Basic encoded",
      provider: "github_user",
    });
    githubMocks.listGitHubUserRepositoryNames.mockResolvedValue([
      "founder/private",
      "opencompany/shared",
    ]);

    await expect(getAvailableGitHubRepositoryNamesForRunner("user_1")).resolves.toEqual([
      "founder/private",
      "opencompany/app",
      "opencompany/shared",
    ]);
    expect(githubMocks.listGitHubUserRepositoryNames).toHaveBeenCalledWith({
      accessToken: "ghu_personal",
    });
  });

  it("does not call GitHub when there is no connected personal account", async () => {
    dbMocks.rows.push([{ name: "opencompany/app" }]);

    await expect(getAvailableGitHubRepositoryNamesForRunner("user_1")).resolves.toEqual([
      "opencompany/app",
    ]);
    expect(githubMocks.listGitHubUserRepositoryNames).not.toHaveBeenCalled();
  });
});

function queryBuilder() {
  const builder = {
    select: () => builder,
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    orderBy: () => builder,
    then: <TResult1 = unknown[], TResult2 = never>(
      onFulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(dbMocks.rows.shift() ?? []).then(onFulfilled, onRejected),
  };
  return builder;
}
