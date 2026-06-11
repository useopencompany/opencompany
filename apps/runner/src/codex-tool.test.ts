import { describe, expect, it } from "vitest";
import {
  buildCodexCommand,
  codexHostedToolUsage,
  createCodexStreamAccumulator,
  resolveCodexTarget,
} from "./codex-tool";

const repo = {
  id: "repo_1",
  fullName: "opencompany/web",
  defaultBranch: "main",
};

describe("resolveCodexTarget", () => {
  it("uses the only attached repository by default", () => {
    expect(resolveCodexTarget({ repositories: [repo] })).toEqual({
      kind: "attached",
      repository: repo,
    });
  });

  it("matches an attached repository by id, full name, or single-repo name", () => {
    expect(resolveCodexTarget({ repositories: [repo], requestedRepository: "repo_1" })).toEqual({
      kind: "attached",
      repository: repo,
    });
    expect(
      resolveCodexTarget({ repositories: [repo], requestedRepository: "opencompany/web" }),
    ).toEqual({ kind: "attached", repository: repo });
    expect(resolveCodexTarget({ repositories: [repo], requestedRepository: "other/web" })).toEqual({
      kind: "attached",
      repository: repo,
    });
  });

  it("supports integration-wide and public GitHub repository targets", () => {
    expect(
      resolveCodexTarget({
        repositories: [],
        allRepositories: true,
        requestedRepository: "opencompany/web",
      }),
    ).toEqual({ kind: "workspace", repositoryFullName: "opencompany/web" });

    expect(
      resolveCodexTarget({
        repositories: [],
        requestedRepository: "https://github.com/opencompany/web",
      }),
    ).toEqual({ kind: "public", repositoryFullName: "opencompany/web" });
  });

  it("requires an explicit repository when there is no unambiguous default", () => {
    expect(() => resolveCodexTarget({ repositories: [] })).toThrow(
      "codex_coder needs a repository argument",
    );
    expect(() =>
      resolveCodexTarget({
        repositories: [repo, { ...repo, id: "repo_2", fullName: "opencompany/runner" }],
      }),
    ).toThrow("More than one repository is attached");
  });
});

describe("buildCodexCommand", () => {
  it("quotes the task, work root, and model without embedding secrets", () => {
    const command = buildCodexCommand({
      task: `edit "README.md"; echo $CODEX_API_KEY`,
      workRoot: "/tmp/work root",
      model: "gpt-5.2-codex",
    });

    expect(command).toContain("codex exec --json");
    expect(command).toContain("--cd '/tmp/work root'");
    expect(command).toContain("--sandbox workspace-write");
    expect(command).toContain("--ask-for-approval never");
    expect(command).toContain("-m 'gpt-5.2-codex'");
    expect(command).toContain(`'edit "README.md"; echo $CODEX_API_KEY'`);
    expect(command).not.toContain("OPENAI_CODEX_API_KEY");
  });
});

describe("createCodexStreamAccumulator", () => {
  it("extracts session id, assistant text, and token usage from JSONL", () => {
    const stream = createCodexStreamAccumulator();

    stream.push(
      [
        JSON.stringify({ type: "session.started", session_id: "codex-session-1" }),
        JSON.stringify({ type: "assistant_message_delta", delta: "Done" }),
        JSON.stringify({
          type: "usage",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            output_tokens: 40,
          },
        }),
      ].join("\n") + "\n",
    );
    stream.finish();

    expect(stream.summary({ exitCode: 0, stdout: "", stderr: "" })).toMatchObject({
      sessionId: "codex-session-1",
      status: "success",
      result: "Done",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 20,
        output_tokens: 40,
      },
    });
  });

  it("reports timeout state without usage when no usage event is emitted", () => {
    const stream = createCodexStreamAccumulator();
    stream.push(`${JSON.stringify({ type: "assistant_message_delta", delta: "Partial" })}\n`);
    stream.finish();

    expect(stream.summary({ exitCode: null, stdout: "", stderr: "", timedOut: true })).toEqual({
      sessionId: null,
      status: "timeout",
      result: "Partial",
      error: "Codex timed out before finishing. The partial diff is shown below.",
      usage: null,
    });
  });
});

describe("codexHostedToolUsage", () => {
  it("prices Codex token usage with platform model pricing", () => {
    const usage = codexHostedToolUsage({
      model: "gpt-5.2-codex",
      summary: {
        usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 100,
          output_tokens: 500,
        },
      },
    });

    expect(usage).toMatchObject({
      provider: "codex",
      operation: "session",
      costSource: "platform_model_pricing",
      rawUsage: {
        model: "gpt-5.2-codex",
        billing_model: "openai/gpt-5.2-codex",
      },
    });
    expect(usage?.costUsdMicros).toBeGreaterThan(0);
  });
});
