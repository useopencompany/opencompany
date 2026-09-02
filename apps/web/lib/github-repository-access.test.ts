import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_COMMAND_TOOL_NAME, USE_ACTION_TOOL_NAME } from "@/lib/chat-ui";
import { fetchGitHubRepositoryAccess, githubInstallGapCandidate } from "./github-repository-access";

describe("GitHub installation gap detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("extracts a structured GitHub plugin repository only from a failed call", () => {
    expect(
      githubInstallGapCandidate({
        name: USE_ACTION_TOOL_NAME,
        status: "failed",
        input: {
          action: "plugin:github:github.pull_request_read",
          params: { owner: "opencompany", repo: "private-repo", pullNumber: 12 },
        },
        output: {
          ok: false,
          error: { code: "provider_error", message: "Resource not accessible by integration" },
        },
      }),
    ).toEqual({ owner: "opencompany", repo: "private-repo" });
    expect(
      githubInstallGapCandidate({
        name: USE_ACTION_TOOL_NAME,
        status: "done",
        input: {
          action: "plugin:github:github.get_file_contents",
          params: { owner: "opencompany", repo: "private-repo" },
        },
        output: { ok: true, result: { content: "" } },
      }),
    ).toBeNull();
  });

  it("does not classify an empty successful result as an installation gap", () => {
    expect(
      githubInstallGapCandidate({
        name: USE_ACTION_TOOL_NAME,
        status: "done",
        input: {
          action: "plugin:github:github.list_pull_requests",
          params: { owner: "opencompany", repo: "private-repo" },
        },
        output: {
          ok: true,
          action: "plugin:github:github.list_pull_requests",
          result: [],
        },
      }),
    ).toBeNull();
  });

  it("extracts a sandbox git remote only for an integration-specific failure", () => {
    expect(
      githubInstallGapCandidate({
        name: CODEX_COMMAND_TOOL_NAME,
        status: "failed",
        input: { command: "git push https://github.com/opencompany/private-repo.git HEAD" },
        output: {
          status: "failed",
          exitCode: 128,
          outputPreview: "remote: Resource not accessible by integration",
        },
      }),
    ).toEqual({ owner: "opencompany", repo: "private-repo" });
    expect(
      githubInstallGapCandidate({
        name: CODEX_COMMAND_TOOL_NAME,
        status: "failed",
        input: { command: "git push https://example.com/opencompany/private-repo.git HEAD" },
        output: { status: "failed", exitCode: 1, outputPreview: "Connection timed out" },
      }),
    ).toBeNull();
    for (const outputPreview of [
      "remote: Repository not found.",
      "remote: error: GH013: Repository rule violations found. Push protection declined.",
      "remote: Permission denied to opencompany/private-repo.git",
      "GitHub returned 403 Forbidden",
    ]) {
      expect(
        githubInstallGapCandidate({
          name: CODEX_COMMAND_TOOL_NAME,
          status: "failed",
          input: { command: "git push https://github.com/opencompany/private-repo.git HEAD" },
          output: { status: "failed", exitCode: 1, outputPreview },
        }),
      ).toBeNull();
    }
  });

  it("shares one account access sweep across repository cards", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        checkedAt: "2026-09-02T12:00:00.000Z",
        target: { owner: "opencompany", repo: null, state: "available" },
        installations: [
          {
            id: "123",
            account: {
              id: "987",
              login: "opencompany",
              type: "Organization",
              avatarUrl: null,
              htmlUrl: "https://github.com/opencompany",
            },
            repositorySelection: "selected",
            permissions: { metadata: "read" },
            pendingPermissions: [],
            suspendedAt: null,
            repositories: [
              {
                id: "456",
                name: "available-repo",
                fullName: "opencompany/available-repo",
                private: true,
                htmlUrl: "https://github.com/opencompany/available-repo",
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [available, missing] = await Promise.all([
      fetchGitHubRepositoryAccess({ owner: "opencompany", repo: "available-repo" }),
      fetchGitHubRepositoryAccess({ owner: "opencompany", repo: "missing-repo" }),
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/github-user/installations?owner=opencompany",
      expect.objectContaining({ method: "GET" }),
    );
    expect(available.target?.state).toBe("available");
    expect(missing.target?.state).toBe("missing_repository");
  });
});
