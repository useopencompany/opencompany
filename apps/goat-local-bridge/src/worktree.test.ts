import { describe, expect, it } from "vitest";
import { buildSessionWorkspacePlan, buildWorktreePlan, validateLocalRepoPath } from "./worktree";

describe("validateLocalRepoPath", () => {
  it("accepts absolute paths under home", () => {
    expect(
      validateLocalRepoPath({ repoPath: "/Users/ada/project", homeDir: "/Users/ada" }),
    ).toEqual({ ok: true, repoPath: "/Users/ada/project" });
  });

  it("rejects relative paths and paths outside home", () => {
    expect(validateLocalRepoPath({ repoPath: "project", homeDir: "/Users/ada" })).toMatchObject({
      ok: false,
    });
    expect(
      validateLocalRepoPath({ repoPath: "/Users/other/project", homeDir: "/Users/ada" }),
    ).toMatchObject({ ok: false });
  });
});

describe("buildWorktreePlan", () => {
  it("constructs git spawn args without shell strings", () => {
    const plan = buildWorktreePlan({
      repoPath: "/Users/ada/project",
      sessionId: "goat_local_codex_123",
      homeDir: "/Users/ada",
    });

    expect(plan.worktreePath).toBe("/Users/ada/.opencompany/goat/worktrees/goat_local_codex_123");
    expect(plan.gitArgs).toEqual([
      "-C",
      "/Users/ada/project",
      "worktree",
      "add",
      "--detach",
      "/Users/ada/.opencompany/goat/worktrees/goat_local_codex_123",
      "HEAD",
    ]);
  });
});

describe("buildSessionWorkspacePlan", () => {
  it("constructs an empty session workspace path under the Goat local area", () => {
    const plan = buildSessionWorkspacePlan({
      sessionId: "goat_local_codex_123/unsafe",
      homeDir: "/Users/ada",
    });

    expect(plan.workspacePath).toBe(
      "/Users/ada/.opencompany/goat/sessions/goat_local_codex_123_unsafe",
    );
  });
});
