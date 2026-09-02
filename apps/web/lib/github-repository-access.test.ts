import { describe, expect, it } from "vitest";
import { CODEX_COMMAND_TOOL_NAME, USE_ACTION_TOOL_NAME } from "@/lib/chat-ui";
import { githubInstallGapCandidate } from "./github-repository-access";

describe("GitHub installation gap detection", () => {
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

  it("checks an empty repository-scoped result so install gaps do not look like no data", () => {
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
    ).toEqual({ owner: "opencompany", repo: "private-repo" });
  });

  it("extracts a sandbox git remote only for an access-shaped failure", () => {
    expect(
      githubInstallGapCandidate({
        name: CODEX_COMMAND_TOOL_NAME,
        status: "failed",
        input: { command: "git push https://github.com/opencompany/private-repo.git HEAD" },
        output: {
          status: "failed",
          exitCode: 128,
          outputPreview: "remote: Repository not found.",
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
  });
});
