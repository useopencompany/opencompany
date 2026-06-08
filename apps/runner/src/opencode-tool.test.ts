import { describe, expect, it, vi } from "vitest";
import {
  buildOpencodeCommand,
  buildOpencodeConfig,
  buildPublicGitHubCloneCommand,
  buildPublicGitHubDefaultBranchCommand,
  clonePublicGitHubRepositoryIntoWorkdir,
  createOpencodeStreamAccumulator,
  parsePublicGitHubRepository,
  resolveOpencodeModel,
  resolveOpencodeTarget,
} from "./opencode-tool";

const attachedRepo = {
  id: "opencompany-web",
  fullName: "opencompany/web",
  defaultBranch: "main",
};

describe("resolveOpencodeModel", () => {
  it("falls back to the default model when omitted", () => {
    expect(resolveOpencodeModel(undefined)).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveOpencodeModel("")).toBe("anthropic/claude-sonnet-4.6");
  });

  it("passes through a supported model id", () => {
    expect(resolveOpencodeModel("openai/gpt-5.4")).toBe("openai/gpt-5.4");
  });

  it("throws on an unsupported model id", () => {
    expect(() => resolveOpencodeModel("acme/not-a-model")).toThrow(/Unsupported opencode model/);
  });

  it("throws on a non-string model", () => {
    expect(() => resolveOpencodeModel(42)).toThrow(/must be a string/);
  });
});

describe("resolveOpencodeTarget", () => {
  it("uses the only attached repository when no repository is requested", () => {
    expect(resolveOpencodeTarget({ repositories: [attachedRepo] })).toEqual({
      kind: "attached",
      repository: attachedRepo,
    });
  });

  it("prefers attached repository id and full-name matches", () => {
    expect(
      resolveOpencodeTarget({
        repositories: [attachedRepo],
        requestedRepository: "opencompany-web",
      }),
    ).toEqual({ kind: "attached", repository: attachedRepo });
    expect(
      resolveOpencodeTarget({
        repositories: [attachedRepo],
        requestedRepository: "OpenCompany/Web",
      }),
    ).toEqual({ kind: "attached", repository: attachedRepo });
  });

  it("uses the only attached repository when the requested owner is stale but repo name matches", () => {
    const repository = {
      id: "useopencompany-opencompany-experimental",
      fullName: "useopencompany/opencompany-experimental",
      defaultBranch: "main",
    };

    expect(
      resolveOpencodeTarget({
        repositories: [repository],
        requestedRepository: "opencompany/opencompany-experimental",
      }),
    ).toEqual({ kind: "attached", repository });
  });

  it("still accepts a distinct public GitHub repository when an attached repo exists", () => {
    expect(
      resolveOpencodeTarget({
        repositories: [attachedRepo],
        requestedRepository: "vercel/next.js",
      }),
    ).toEqual({
      kind: "public",
      repositoryFullName: "vercel/next.js",
    });
  });

  it("accepts public GitHub owner/repo and https URLs", () => {
    expect(
      resolveOpencodeTarget({ repositories: [], requestedRepository: "vercel/next.js" }),
    ).toEqual({
      kind: "public",
      repositoryFullName: "vercel/next.js",
    });
    expect(
      resolveOpencodeTarget({
        repositories: [],
        requestedRepository: "https://github.com/vercel/next.js",
      }),
    ).toEqual({ kind: "public", repositoryFullName: "vercel/next.js" });
    expect(
      resolveOpencodeTarget({
        repositories: [],
        requestedRepository: "https://github.com/vercel/next.js/tree/canary/packages/next",
      }),
    ).toEqual({ kind: "public", repositoryFullName: "vercel/next.js" });
  });

  it("rejects missing, SSH, non-GitHub, and malformed public repositories", () => {
    expect(() => resolveOpencodeTarget({ repositories: [] })).toThrow(/needs a repository/);
    expect(parsePublicGitHubRepository("git@github.com:vercel/next.js.git")).toBeNull();
    expect(parsePublicGitHubRepository("ssh://github.com/vercel/next.js.git")).toBeNull();
    expect(parsePublicGitHubRepository("https://gitlab.com/vercel/next.js")).toBeNull();
    expect(parsePublicGitHubRepository("vercel/next.js/packages")).toBeNull();
    expect(() =>
      resolveOpencodeTarget({
        repositories: [],
        requestedRepository: "https://gitlab.com/vercel/next.js",
      }),
    ).toThrow(/not an attached repository or a supported public GitHub repository/);
  });
});

describe("public GitHub clone helpers", () => {
  it("builds unauthenticated public GitHub discovery and clone commands", () => {
    expect(buildPublicGitHubDefaultBranchCommand("vercel/next.js")).toContain(
      "git ls-remote --symref 'https://github.com/vercel/next.js.git' HEAD",
    );
    expect(
      buildPublicGitHubCloneCommand({
        workdir: "/home/user/workspace/work",
        repositoryFullName: "vercel/next.js",
        defaultBranch: "canary",
      }),
    ).toBe(
      "rm -rf '/home/user/workspace/work' && git clone --depth 1 --branch 'canary' 'https://github.com/vercel/next.js.git' '/home/user/workspace/work'",
    );
  });

  it("clones public repositories without GitHub token env", async () => {
    const sandbox = {
      commands: {
        run: vi.fn(async (command: string) => {
          if (command.includes("git remote get-url")) {
            return { stdout: "__opencompany_missing_git__\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
    };

    await clonePublicGitHubRepositoryIntoWorkdir({
      sandbox: sandbox as never,
      workdir: "/home/user/workspace/work",
      repositoryFullName: "vercel/next.js",
      defaultBranch: "canary",
    });

    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("git clone --depth 1 --branch 'canary'"),
      { timeoutMs: 120_000 },
    );
    expect(
      (sandbox.commands.run.mock.calls as Array<[string, Record<string, unknown>?]>).some(
        ([, options]) => Boolean(options?.envs),
      ),
    ).toBe(false);
  });
});

describe("buildOpencodeCommand", () => {
  it("builds a headless json run with auto-approved permissions", () => {
    const command = buildOpencodeCommand({
      task: "fix the bug",
      model: "gateway/anthropic/claude-sonnet-4.6",
    });
    expect(command).toContain("opencode run");
    expect(command).toContain("--format json");
    expect(command).toContain("--model 'gateway/anthropic/claude-sonnet-4.6'");
    expect(command).toContain("--dangerously-skip-permissions");
    expect(command).toContain("'fix the bug'");
    expect(command).not.toContain("--session");
  });

  it("continues an existing session when an id is provided", () => {
    const command = buildOpencodeCommand({
      task: "follow up",
      model: "gateway/openai/gpt-5.4",
      sessionId: "ses_123",
    });
    expect(command).toContain("--session 'ses_123'");
  });
});

describe("buildOpencodeConfig", () => {
  it("points opencode at the Vercel AI Gateway provider", () => {
    const config = JSON.parse(buildOpencodeConfig("anthropic/claude-sonnet-4.6"));
    expect(config.model).toBe("gateway/anthropic/claude-sonnet-4.6");
    expect(config.provider.gateway.npm).toBe("@ai-sdk/openai-compatible");
    expect(config.provider.gateway.options.baseURL).toBe("https://ai-gateway.vercel.sh/v1");
    expect(config.provider.gateway.options.apiKey).toBe("{env:VERCEL_AI_GATEWAY_API_KEY}");
    expect(config.provider.gateway.models["anthropic/claude-sonnet-4.6"]).toBeDefined();
  });
});

describe("createOpencodeStreamAccumulator", () => {
  it("captures session id, assistant text, tokens, and cost from JSON events", () => {
    const stream = createOpencodeStreamAccumulator();
    stream.push(`${JSON.stringify({ type: "session", session: { id: "ses_abc" } })}\n`);
    stream.push(`${JSON.stringify({ type: "text", text: "Done. " })}\n`);
    stream.push(
      `${JSON.stringify({
        type: "message",
        info: {
          tokens: { input: 100, output: 40, cache: { read: 10, write: 5 } },
          cost: 0.25,
        },
      })}\n`,
    );
    stream.finish();
    const summary = stream.summary({ exitCode: 0, stdout: "", stderr: "" });

    expect(summary.sessionId).toBe("ses_abc");
    expect(summary.status).toBe("success");
    expect(summary.result).toBe("Done.");
    expect(summary.usage).toEqual({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    });
    expect(summary.costUsdMicros).toBe(250_000);
  });

  it("falls back to raw stdout and marks errors on a non-zero exit", () => {
    const stream = createOpencodeStreamAccumulator();
    stream.finish();
    const summary = stream.summary({
      exitCode: 1,
      stdout: "raw output",
      stderr: "boom",
    });
    expect(summary.status).toBe("error");
    expect(summary.result).toBe("raw output");
    expect(summary.error).toBe("boom");
    expect(summary.usage).toBeNull();
    expect(summary.costUsdMicros).toBeNull();
  });

  it("tolerates non-JSON log lines without throwing", () => {
    const stream = createOpencodeStreamAccumulator();
    expect(() => stream.push("INFO starting opencode\n")).not.toThrow();
    stream.push(`${JSON.stringify({ type: "text", text: "ok" })}\n`);
    stream.finish();
    expect(stream.summary({ exitCode: 0, stdout: "", stderr: "" }).result).toBe("ok");
  });

  it("marks a timed-out run and surfaces the resumable session id + partial result", () => {
    const stream = createOpencodeStreamAccumulator();
    stream.push(`${JSON.stringify({ type: "session", sessionID: "ses_abc" })}\n`);
    stream.push(`${JSON.stringify({ type: "text", text: "partial work so far" })}\n`);
    stream.finish();
    // timedOut wins over the exit code so a killed process is never reported as success.
    const summary = stream.summary({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    expect(summary.status).toBe("timeout");
    expect(summary.sessionId).toBe("ses_abc");
    expect(summary.result).toBe("partial work so far");
    expect(summary.error).toMatch(/resume/i);
  });
});
