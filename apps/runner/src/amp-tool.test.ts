import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubWorkRepositoryDb } from "./agent-loop-test-support";
import {
  buildAmpCommand,
  buildAmpCommandEnv,
  createAmpActivityFormatter,
  createAmpStreamAccumulator,
  createKnownSecretRedactor,
  fetchAmpThreadCost,
  loadGitHubWorkRepository,
  selectPublishBranch,
} from "./amp-tool";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("fetchAmpThreadCost", () => {
  const threadId = "T-abc123";
  const apiKey = "sgamp_test_key";
  const baseUrl = "https://amp.test";

  it("returns cost in USD micros on successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              threadID: threadId,
              subThreadIDs: [],
              usage: 2.5,
              models: [
                {
                  provider: "anthropic",
                  model: "claude-sonnet-4-20250514",
                  requests: 5,
                  inputTokens: 10000,
                  outputTokens: 2000,
                  cacheReadInputTokens: 5000,
                  cacheCreationInputTokens: 1000,
                  usage: 2.5,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBe(2_500_000);

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/api/v2/threads/${threadId}/usage`,
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
    );
  });

  it("returns null on 403 (non-Enterprise / forbidden)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Forbidden: missing client scope(s)" }), {
            status: 403,
          }),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBeNull();
  });

  it("returns null on 402 (payment required)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ error: "Payment required" }), { status: 402 }),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBeNull();
  });

  it("returns null on 401 (unauthorized)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Network failure");
      }),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBeNull();
  });

  it("returns null when response body has no usage field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ threadID: threadId }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBeNull();
  });

  it("returns null when usage is negative", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ threadID: threadId, subThreadIDs: [], usage: -1, models: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBeNull();
  });

  it("rounds fractional micros correctly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ threadID: threadId, subThreadIDs: [], usage: 0.0035, models: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const result = await fetchAmpThreadCost(threadId, apiKey, baseUrl);
    expect(result).toBe(3500);
  });
});

describe("Amp stream parsing", () => {
  it("starts a new Amp thread when no prior thread id is provided", () => {
    expect(buildAmpCommand({ task: "implement the change" })).toBe(
      "amp --dangerously-allow-all --mode smart -x 'implement the change'",
    );
  });

  it("allows Amp mode to be selected for harder tasks", () => {
    expect(buildAmpCommand({ task: "implement the change", mode: "deep" })).toBe(
      "amp --dangerously-allow-all --mode deep -x 'implement the change'",
    );
  });

  it("continues an existing Amp thread when a prior thread id is provided", () => {
    expect(
      buildAmpCommand({
        task: "address the follow-up",
        ampThreadId: "T-2775dc92-90ed-4f85-8b73-8f9766029e83",
        mode: "rush",
      }),
    ).toBe(
      "amp threads continue --dangerously-allow-all --mode rush -x 'address the follow-up' 'T-2775dc92-90ed-4f85-8b73-8f9766029e83'",
    );
  });

  it("rejects GitHub repositories whose parent connection needs reauthorization", async () => {
    const db = createGitHubWorkRepositoryDb([
      {
        integrationId: "wint_123",
        fullName: "opencompany/web",
        installationId: "12345",
        connectionLabel: "opencompany",
        connectionStatus: "needs_reauth",
        connectionStatusReason: "Installation token failed with 401.",
        resourceStatus: "available",
        resourceStatusReason: null,
      },
    ]);
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      loadGitHubWorkRepository("wks_123", {
        id: "opencompany-web",
        fullName: "opencompany/web",
        defaultBranch: "main",
      }),
    ).rejects.toThrow(
      "GitHub connection opencompany is needs reauth. Reconnect GitHub or update the agent repository mention. Installation token failed with 401.",
    );
    expect(db.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "needs_reauth",
        statusReason: "Installation token failed with 401.",
      }),
    );
  });

  it("rejects GitHub repositories with degraded resource status", async () => {
    const db = createGitHubWorkRepositoryDb([
      {
        integrationId: "wint_123",
        fullName: "opencompany/web",
        installationId: "12345",
        connectionLabel: "opencompany",
        connectionStatus: "connected",
        connectionStatusReason: null,
        resourceStatus: "permission_lost",
        resourceStatusReason: "Repository is no longer visible to the GitHub installation.",
      },
    ]);
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      loadGitHubWorkRepository("wks_123", {
        id: "opencompany-web",
        fullName: "opencompany/web",
        defaultBranch: "main",
      }),
    ).rejects.toThrow(
      "GitHub repository opencompany/web is no longer available to this workspace. Reconnect GitHub or update the agent repository mention. Repository is no longer visible to the GitHub installation.",
    );
    expect(db.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "sync_failed",
        statusReason: "Repository is no longer visible to the GitHub installation.",
      }),
    );
  });

  it("rejects ambiguous unbound GitHub repositories across multiple usable connections", async () => {
    const db = createGitHubWorkRepositoryDb([
      {
        integrationId: "wint_123",
        fullName: "opencompany/web",
        installationId: "12345",
        connectionLabel: "opencompany",
        connectionStatus: "connected",
        connectionStatusReason: null,
        resourceStatus: "available",
        resourceStatusReason: null,
      },
      {
        integrationId: "wint_456",
        fullName: "opencompany/web",
        installationId: "45678",
        connectionLabel: "opencompany-eu",
        connectionStatus: "connected",
        connectionStatusReason: null,
        resourceStatus: "available",
        resourceStatusReason: null,
      },
    ]);
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      loadGitHubWorkRepository("wks_123", {
        id: "opencompany-web",
        fullName: "opencompany/web",
        defaultBranch: "main",
      }),
    ).rejects.toThrow(
      "GitHub work repository opencompany/web matches multiple workspace connections. Re-save the agent with a concrete repository binding.",
    );
  });

  it("builds ephemeral GitHub auth env for Amp without putting tokens in the command", () => {
    const env = buildAmpCommandEnv({
      ampApiKey: "amp_secret_123",
      githubAuthHeader: "Authorization: Basic github_basic_secret",
      githubToken: "github_token_123",
      toolCallId: "toolu/with spaces",
    });

    expect(env).toMatchObject({
      AMP_API_KEY: "amp_secret_123",
      GH_TOKEN: "github_token_123",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_CONFIG_DIR: "/tmp/opencompany-gh-toolu-with-spaces",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "Authorization: Basic github_basic_secret",
    });
    expect(env).not.toHaveProperty("GH_REPO");
    expect(buildAmpCommand({ task: "open a pr" })).not.toContain("github_token_123");
  });

  it("adds GitHub default repo context when an env builder receives one", () => {
    const env = buildAmpCommandEnv({
      ampApiKey: "amp_secret_123",
      githubAuthHeader: "Authorization: Basic github_basic_secret",
      githubToken: "github_token_123",
      repositoryFullName: "opencompany/web",
      toolCallId: "toolu/with spaces",
    });

    expect(env).toMatchObject({
      GH_REPO: "opencompany/web",
      GH_TOKEN: "github_token_123",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
    });
  });

  it("redacts known Amp and GitHub secrets from streamed or saved text", () => {
    const redact = createKnownSecretRedactor([
      "amp_secret_123",
      "github_token_123",
      "Authorization: Basic github_basic_secret",
    ]);

    expect(
      redact(
        "AMP=amp_secret_123 GH=github_token_123 header=Authorization: Basic github_basic_secret",
      ),
    ).toBe("AMP=[redacted] GH=[redacted] header=[redacted]");
  });

  it("publishes Amp's non-default branch when one exists", () => {
    expect(
      selectPublishBranch({
        currentBranch: "feature/from-amp",
        defaultBranch: "main",
        sessionId: "ses_845254899642482b9082",
        now: 123,
      }),
    ).toBe("feature/from-amp");
  });

  it("uses a generated branch instead of pushing the default branch", () => {
    expect(
      selectPublishBranch({
        currentBranch: "main",
        defaultBranch: "main",
        sessionId: "ses_845254899642482b9082",
        now: 123,
      }),
    ).toBe("opencompany/amp-482b9082-123");
  });

  it("captures the final successful Amp result across stdout chunks", () => {
    const stream = createAmpStreamAccumulator();

    stream.push(
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "T-123",
          tools: [],
          mcp_servers: [],
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "intermediate answer" }],
            stop_reason: "end_turn",
          },
          parent_tool_use_id: null,
          session_id: "T-123",
        }),
      ].join("\n"),
    );
    stream.push(
      `\n${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 1200,
        is_error: false,
        num_turns: 1,
        result: "final answer",
        session_id: "T-123",
      }).slice(0, 80)}`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 1200,
        is_error: false,
        num_turns: 1,
        result: "final answer",
        session_id: "T-123",
      }).slice(80)}\n`,
    );

    stream.finish();

    expect(stream.summary()).toEqual({
      threadId: "T-123",
      status: "success",
      result: "final answer",
      error: null,
      durationMs: 1200,
      numTurns: 1,
      permissionDenials: [],
      usage: null,
    });
  });

  it("falls back to the last assistant text when Amp omits result text", () => {
    const stream = createAmpStreamAccumulator();

    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "assistant fallback" }],
          stop_reason: "end_turn",
        },
        parent_tool_use_id: null,
        session_id: "T-456",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 900,
        is_error: false,
        num_turns: 1,
        result: "",
        session_id: "T-456",
      })}\n`,
    );

    stream.finish();

    expect(stream.summary()).toMatchObject({
      threadId: "T-456",
      status: "success",
      result: "assistant fallback",
      error: null,
    });
  });

  it("captures plain Amp output when JSON streaming is not requested", () => {
    const stream = createAmpStreamAccumulator();

    stream.push("\u001b[?25hWorking on it...\n");
    stream.push("Done with the implementation.\n");

    expect(stream.summary({ exitCode: 0 })).toMatchObject({
      threadId: null,
      status: "success",
      result: "Working on it...\nDone with the implementation.",
      error: null,
    });
  });

  it("captures Amp execution errors as structured output", () => {
    const stream = createAmpStreamAccumulator();

    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        duration_ms: 300,
        is_error: true,
        num_turns: 1,
        error: "permission denied",
        session_id: "T-789",
        permission_denials: ["Bash rm -rf"],
      })}\n`,
    );
    stream.finish();

    expect(stream.summary()).toEqual({
      threadId: "T-789",
      status: "error",
      result: "",
      error: "permission denied",
      durationMs: 300,
      numTurns: 1,
      permissionDenials: ["Bash rm -rf"],
      usage: null,
    });
  });

  it("accumulates usage from multiple assistant events", () => {
    const stream = createAmpStreamAccumulator();

    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
        },
        session_id: "T-usage-1",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          usage: {
            input_tokens: 200,
            output_tokens: 80,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 10,
          },
        },
        session_id: "T-usage-1",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 500,
        is_error: false,
        num_turns: 2,
        result: "done",
        session_id: "T-usage-1",
      })}\n`,
    );
    stream.finish();

    expect(stream.summary()).toEqual({
      threadId: "T-usage-1",
      status: "success",
      result: "done",
      error: null,
      durationMs: 500,
      numTurns: 2,
      permissionDenials: [],
      usage: {
        input_tokens: 300,
        output_tokens: 130,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 30,
      },
    });
  });

  it("prefers result event usage over accumulated sum", () => {
    const stream = createAmpStreamAccumulator();

    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "step" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        session_id: "T-usage-2",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 400,
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "T-usage-2",
        usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 80 },
      })}\n`,
    );
    stream.finish();

    expect(stream.summary()).toEqual({
      threadId: "T-usage-2",
      status: "success",
      result: "done",
      error: null,
      durationMs: 400,
      numTurns: 1,
      permissionDenials: [],
      usage: {
        input_tokens: 500,
        output_tokens: 200,
        cache_read_input_tokens: 80,
      },
    });
  });

  it("returns usage null when no usage data is present", () => {
    const stream = createAmpStreamAccumulator();

    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "no usage" }],
        },
        session_id: "T-usage-3",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 100,
        is_error: false,
        num_turns: 1,
        result: "ok",
        session_id: "T-usage-3",
      })}\n`,
    );
    stream.finish();

    expect(stream.summary().usage).toBeNull();
  });

  it("falls back to accumulated usage when the result event reports zero tokens", () => {
    const stream = createAmpStreamAccumulator();
    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "step" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        session_id: "T-usage-zero-result",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 200,
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "T-usage-zero-result",
        usage: { input_tokens: 0, output_tokens: 0 },
      })}\n`,
    );
    stream.finish();

    expect(stream.summary().usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
    });
  });

  it("preserves cache token counts when result event reports zero tokens but has cache fields", () => {
    const stream = createAmpStreamAccumulator();
    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "step" }],
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        session_id: "T-usage-cache-zero",
      })}\n`,
    );
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 200,
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "T-usage-cache-zero",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 200,
        },
      })}\n`,
    );
    stream.finish();

    expect(stream.summary().usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 200,
    });
  });

  it("accepts result event whose usage carries only cache fields", () => {
    const stream = createAmpStreamAccumulator();
    stream.push(
      `${JSON.stringify({
        type: "result",
        subtype: "success",
        duration_ms: 150,
        is_error: false,
        num_turns: 1,
        result: "done",
        session_id: "T-usage-cache-only",
        usage: { cache_read_input_tokens: 800 },
      })}\n`,
    );
    stream.finish();

    expect(stream.summary().usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 800,
    });
  });

  it("accumulates assistant events whose usage carries only cache fields", () => {
    const stream = createAmpStreamAccumulator();
    stream.push(
      `${JSON.stringify({
        type: "assistant",
        message: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "cached step" }],
          usage: { cache_read_input_tokens: 1234 },
        },
        session_id: "T-usage-assistant-cache-only",
      })}\n`,
    );
    stream.finish();

    expect(stream.summary().usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1234,
    });
  });

  it("formats Amp stream activity without leaking partial JSON chunks", () => {
    const formatter = createAmpActivityFormatter();
    const assistantEvent = JSON.stringify({
      type: "assistant",
      message: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "bun test apps/runner/src/agent-loop.test.ts" },
          },
        ],
      },
      session_id: "T-123",
    });

    expect(formatter.push(`${assistantEvent.slice(0, 40)}`)).toBe("");
    expect(formatter.push(`${assistantEvent.slice(40)}\n`)).toBe(
      'Amp is using Bash: {"command":"bun test apps/runner/src/agent-loop.test.ts"}.\n',
    );
  });

  it("summarizes Amp session lifecycle and final result events", () => {
    const formatter = createAmpActivityFormatter();

    const output = formatter.push(
      [
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "T-123",
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          duration_ms: 1250,
          num_turns: 2,
          is_error: false,
          result: "Done",
          session_id: "T-123",
        }),
      ].join("\n") + "\n",
    );

    expect(output).toBe("Amp session T-123 started.\nAmp completed in 1.3s, 2 turns.\n");
  });
});
