import { calculateModelUsageCost } from "@opencompany/billing";
import { describe, expect, it, vi } from "vitest";
import {
  buildOpencodeCommand,
  buildOpencodeConfig,
  buildPublicGitHubCloneCommand,
  buildPublicGitHubDefaultBranchCommand,
  clonePublicGitHubRepositoryIntoWorkdir,
  createOpencodeStreamAccumulator,
  opencodeHostedToolUsage,
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

  describe("allRepositories (live @github scope)", () => {
    it("resolves a non-attached owner/repo as a workspace target", () => {
      expect(
        resolveOpencodeTarget({
          repositories: [attachedRepo],
          requestedRepository: "opencompany/other",
          allRepositories: true,
        }),
      ).toEqual({ kind: "workspace", repositoryFullName: "opencompany/other" });
      expect(
        resolveOpencodeTarget({
          repositories: [],
          requestedRepository: "https://github.com/opencompany/other",
          allRepositories: true,
        }),
      ).toEqual({ kind: "workspace", repositoryFullName: "opencompany/other" });
    });

    it("still prefers attached repository matches", () => {
      expect(
        resolveOpencodeTarget({
          repositories: [attachedRepo],
          requestedRepository: "opencompany/web",
          allRepositories: true,
        }),
      ).toEqual({ kind: "attached", repository: attachedRepo });
    });

    it("requires the repository argument when nothing is attached", () => {
      expect(() => resolveOpencodeTarget({ repositories: [], allRepositories: true })).toThrow(
        /needs the repository argument/,
      );
    });
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

  it("reads tokens and cost from current step_finish events (part payload, opencode >=1.17)", () => {
    // Verbatim shape captured from a real `opencode run --format json` against the
    // platform gateway (2026-06-11, opencode 1.17.3): usage lives under `part`, not
    // `info`, and cost self-reports 0 because opencode cannot price the custom
    // gateway provider (OC-328).
    const stream = createOpencodeStreamAccumulator();
    stream.push(
      `${JSON.stringify({
        type: "step_finish",
        timestamp: 1781173519306,
        sessionID: "ses_149c9072dffefTjnjV2CvdfyM7",
        part: {
          id: "prt_eb63703bb001CnLNQqnXq9F2dQ",
          messageID: "msg_eb636fbe5001GHWabnmprTSrs7",
          sessionID: "ses_149c9072dffefTjnjV2CvdfyM7",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: {
            total: 11549,
            input: 11545,
            output: 4,
            reasoning: 0,
            cache: { write: 0, read: 0 },
          },
        },
      })}\n`,
    );
    stream.finish();
    const summary = stream.summary({ exitCode: 0, stdout: "", stderr: "" });
    expect(summary.sessionId).toBe("ses_149c9072dffefTjnjV2CvdfyM7");
    expect(summary.usage).toEqual({ input_tokens: 11545, output_tokens: 4 });
    expect(summary.costUsdMicros).toBe(0);
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

describe("opencodeHostedToolUsage", () => {
  it("bills gateway runs from platform pricing even though opencode self-reports cost 0 (OC-328)", () => {
    // The exact shape a gateway run produces: token counts present, cost 0 because
    // opencode's catalog has no pricing for the custom "gateway" provider.
    const usage = opencodeHostedToolUsage({
      modelId: "anthropic/claude-haiku-4.5",
      summary: {
        usage: { input_tokens: 11_000, output_tokens: 600, cache_creation_input_tokens: 5_000 },
        costUsdMicros: 0,
      },
    });
    expect(usage).not.toBeNull();
    expect(usage?.costUsdMicros).toBeGreaterThan(0);
    expect(usage?.rawUsage.cost_source).toBe("platform_model_pricing");
    expect(usage?.rawUsage.opencode_reported_cost_usd_micros).toBe(0);
  });

  it("prices tokens with the same rates the main agent loop bills", () => {
    const usage = opencodeHostedToolUsage({
      modelId: "anthropic/claude-sonnet-4.6",
      summary: {
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 500_000,
          cache_read_input_tokens: 200_000,
          cache_creation_input_tokens: 100_000,
        },
        costUsdMicros: null,
      },
    });
    const expected = calculateModelUsageCost({
      modelName: "anthropic/claude-sonnet-4.6",
      inputTokens: 1_300_000,
      inputNoCacheTokens: 1_000_000,
      inputCacheReadTokens: 200_000,
      inputCacheWriteTokens: 100_000,
      outputTokens: 500_000,
    });
    expect(usage?.costUsdMicros).toBe(expected.providerCostUsdMicros);
    // sonnet-4.6: 1M uncached @ $3/M + 200k cache-read @ $0.30/M + 100k cache-write
    // @ $3.75/M + 500k output @ $15/M = $10.935 provider cost.
    expect(usage?.costUsdMicros).toBe(10_935_000);
    expect(usage?.provider).toBe("opencode");
    expect(usage?.operation).toBe("session");
    expect(usage?.rawUsage.model).toBe("anthropic/claude-sonnet-4.6");
  });

  it("prefers platform pricing over a non-zero opencode-reported cost", () => {
    const usage = opencodeHostedToolUsage({
      modelId: "anthropic/claude-haiku-4.5",
      summary: {
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
        costUsdMicros: 999,
      },
    });
    // 1M uncached haiku input @ $1/M = $1.00, not the self-reported $0.000999.
    expect(usage?.costUsdMicros).toBe(1_000_000);
    expect(usage?.rawUsage.cost_source).toBe("platform_model_pricing");
    expect(usage?.rawUsage.opencode_reported_cost_usd_micros).toBe(999);
  });

  it("falls back to the opencode-reported cost when no token counts were streamed", () => {
    const usage = opencodeHostedToolUsage({
      modelId: "anthropic/claude-sonnet-4.6",
      summary: { usage: null, costUsdMicros: 250_000 },
    });
    expect(usage?.costUsdMicros).toBe(250_000);
    expect(usage?.rawUsage.cost_source).toBe("opencode_reported");
  });

  it("returns null when the run produced neither tokens nor a reported cost", () => {
    expect(
      opencodeHostedToolUsage({
        modelId: "anthropic/claude-sonnet-4.6",
        summary: { usage: null, costUsdMicros: null },
      }),
    ).toBeNull();
    expect(
      opencodeHostedToolUsage({
        modelId: "anthropic/claude-sonnet-4.6",
        summary: { usage: null, costUsdMicros: 0 },
      }),
    ).toBeNull();
  });
});
