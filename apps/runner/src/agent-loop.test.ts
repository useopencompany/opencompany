import {
  RUNTIME_TOOL_DEFINITION_BY_NAME,
  type RuntimeToolDefinition,
} from "@opencompany/agent-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageForLease,
  createHostedToolBudget,
  executeRuntimeTool,
} from "./agent-loop";
import {
  agentConfig,
  createLeaseDb,
  createStateLeaseWriteStore,
  env,
  type LeaseDbState,
} from "./agent-loop-test-support";
import { appendRuntimeEvent, publishTransientRuntimeEvent } from "./events";
import { type LeaseWriteStore, setLeaseWriteStoreForTests } from "./lease-writes";

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

const observabilityMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

const braintrustMocks = vi.hoisted(() => ({
  getBraintrustAISDK: vi.fn((aiSDK: object) => aiSDK),
  flushBraintrust: vi.fn(async () => {}),
  logBraintrustCurrentSpan: vi.fn(),
  logBraintrustSpan: vi.fn(),
  traceBraintrust: vi.fn(
    async (
      _input: unknown,
      run: (span: { log: (fields: unknown) => void } | undefined) => Promise<unknown>,
    ) => run({ log: vi.fn() }),
  ),
  traceBraintrustStep: vi.fn(
    async (
      _name: string,
      run: (span: { log: (fields: unknown) => void } | undefined) => Promise<unknown>,
    ) => run({ log: vi.fn() }),
  ),
}));

const githubMocks = vi.hoisted(() => ({
  createDraftPullRequest: vi.fn(),
  getGitHubWorkInstallationToken: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: dbMocks.getDb,
}));

vi.mock("@opencompany/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/observability")>();
  return {
    ...actual,
    captureException: observabilityMocks.captureException,
  };
});

vi.mock("@opencompany/observability/braintrust", () => braintrustMocks);

vi.mock("./events", () => ({
  appendRuntimeEvent: vi.fn(async () => ({ id: 1 })),
  publishTransientRuntimeEvent: vi.fn((event) => ({ ...event, id: null, transient: true })),
}));

vi.mock("./github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github")>();
  return {
    ...actual,
    createDraftPullRequest: githubMocks.createDraftPullRequest,
    getGitHubWorkInstallationToken: githubMocks.getGitHubWorkInstallationToken,
  };
});

// Lease-guarded DB writes run atomic conditional statements that the hand-rolled fake
// db cannot interpret, so route them through an in-memory store bound to the current
// fake db's `state`. Reads, the lease claim, and the ledger debit still hit the fake db.
beforeEach(() => {
  setLeaseWriteStoreForTests(
    createStateLeaseWriteStore(() => (dbMocks.getDb() as { state: LeaseDbState }).state),
  );
});

afterEach(() => {
  setLeaseWriteStoreForTests(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("runtime tool dispatch", () => {
  it("executes hosted tools without hydrating the sandbox", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              requestId: "exa_req_123",
              searchType: "auto",
              costDollars: { total: 0.001 },
              results: [],
            }),
            { status: 200 },
          ),
      ),
    );
    const getSandbox = vi.fn(async () => {
      throw new Error("sandbox should not hydrate");
    });

    await executeRuntimeTool({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      agentConfig: agentConfig(),
      toolCallId: "call_exa",
      definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("exa_search") as RuntimeToolDefinition,
      args: { query: "test" },
      getSandbox,
      workdir: "/home/user/workspace",
      env: env(),
      enabledTools: ["tool_help", "exa_search"],
      signal: new AbortController().signal,
      checkAbort: async () => {},
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(db.state.toolUsage).toHaveLength(1);
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "exa_search",
      toolCallId: "call_exa",
    });
  });

  it("records Amp usage streamed through the runtime tool dispatcher", async () => {
    const db = createLeaseDb({
      runLeaseId: "run_123",
      githubRows: [
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
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    githubMocks.getGitHubWorkInstallationToken.mockResolvedValue("github_token_123");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ threadID: "T-amp-usage", usage: 0.00815 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const sandboxRun = vi.fn(
      async (command: string, options?: { onStdout?: (data: string) => void }) => {
        if (command.includes("git rev-parse --is-inside-work-tree")) return { stdout: "true" };
        if (command.includes("amp --dangerously-allow-all")) {
          options?.onStdout?.(
            `${JSON.stringify({
              type: "assistant",
              message: {
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "working" }],
                usage: { input_tokens: 100, output_tokens: 20 },
              },
              session_id: "T-amp-usage",
            })}\n`,
          );
          options?.onStdout?.(
            `${JSON.stringify({
              type: "result",
              subtype: "success",
              duration_ms: 500,
              is_error: false,
              num_turns: 1,
              result: "done",
              session_id: "T-amp-usage",
              usage: {
                input_tokens: 1_000,
                cache_creation_input_tokens: 25,
                cache_read_input_tokens: 50,
                output_tokens: 100,
              },
            })}\n`,
          );
          return { stdout: "", exitCode: 0 };
        }
        if (command.includes("git status --short")) return { stdout: "" };
        if (command.includes("git diff HEAD --stat")) return { stdout: "" };
        if (command.includes("git diff HEAD -- | head -400")) return { stdout: "" };
        if (command.includes("git branch --show-current")) return { stdout: "main\n" };
        if (command.includes("git rev-list --count")) return { stdout: "0\n" };
        return { stdout: "" };
      },
    );
    const ampAgentConfig = agentConfig();
    ampAgentConfig.tools = [
      {
        id: "amp",
        type: "coding_agent",
        provider: "amp",
        label: "Amp",
        description: "Delegate coding work to Amp.",
        prCapable: false,
      },
    ];
    ampAgentConfig.integrations.github.repositories = [
      {
        id: "opencompany-web",
        fullName: "opencompany/web",
        defaultBranch: "main",
      },
    ];

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        workspaceId: "wsp_123",
        agentConfig: ampAgentConfig,
        toolCallId: "call_amp",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("amp_coder") as RuntimeToolDefinition,
        args: { task: "implement the change" },
        getSandbox: (async () => ({
          sandboxId: "sbx_amp",
          commands: { run: sandboxRun },
        })) as never,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["amp_coder"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
      }),
    ).resolves.toMatchObject({
      ampThreadId: "T-amp-usage",
      usage: {
        provider: "amp",
        operation: "session",
        costUsdMicros: 8_150,
        rawUsage: {
          input_tokens: 1_000,
          cache_creation_input_tokens: 25,
          cache_read_input_tokens: 50,
          output_tokens: 100,
        },
      },
    });

    expect(db.state.toolUsage).toEqual([
      expect.objectContaining({
        toolCallId: "call_amp",
        toolName: "amp_coder",
        provider: "amp",
        operation: "session",
        costUsdMicros: 8_150,
      }),
    ]);
    expect(db.state.ledgerDebits).toBe(1);
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "session.tool_usage",
        payload: expect.objectContaining({
          toolCallId: "call_amp",
          provider: "amp",
          operation: "session",
          costUsdMicros: 8_150,
        }),
      }),
    );
  });

  it("executes agent delegation as an internal tool without hydrating the sandbox", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => {
      throw new Error("sandbox should not hydrate");
    });
    const delegateToAgent = vi.fn(async () => ({
      ok: true,
      status: "completed",
      childSessionId: "ses_child",
      answer: "Research complete.",
    }));

    await executeRuntimeTool({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      agentConfig: agentConfig(),
      toolCallId: "call_delegate",
      definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("delegate_to_agent") as RuntimeToolDefinition,
      args: { agent: "agent/research", prompt: "Summarize the market." },
      getSandbox,
      workdir: "/home/user/workspace",
      env: env(),
      enabledTools: ["tool_help", "delegate_to_agent"],
      signal: new AbortController().signal,
      checkAbort: async () => {},
      delegateToAgent,
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(delegateToAgent).toHaveBeenCalledWith({
      agent: "agent/research",
      prompt: "Summarize the market.",
      toolCallId: "call_delegate",
    });
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "delegate_to_agent",
      toolCallId: "call_delegate",
      content: expect.stringContaining("Research complete."),
    });
  });

  it("reuses an incomplete assistant response for a retried user message", async () => {
    const db = createLeaseDb({
      runLeaseId: "run_123",
      messages: [
        {
          id: "msg_assistant_1",
          sessionId: "ses_123",
          status: "running",
          responseToMessageId: "msg_user",
        },
      ],
    });
    dbMocks.getDb.mockReturnValue(db);

    await expect(
      createAssistantMessageForLease({
        id: "msg_assistant_1",
        sessionId: "ses_123",
        responseToMessageId: "msg_user",
        leaseId: "run_123",
        leaseOwner: "runner-test",
      }),
    ).resolves.toBe(true);

    expect(db.state.messages).toHaveLength(1);
  });

  it("blocks hosted search fan-out after the per-message budget", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            requestId: "exa_req_123",
            searchType: "auto",
            costDollars: { total: 0.001 },
            results: [],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const budget = createHostedToolBudget();

    for (let index = 0; index < 8; index += 1) {
      await executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        workspaceId: "wsp_123",
        agentConfig: agentConfig(),
        toolCallId: `call_exa_${index}`,
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("exa_search") as RuntimeToolDefinition,
        args: { query: `test ${index}` },
        getSandbox: async () => {
          throw new Error("sandbox should not hydrate");
        },
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["tool_help", "exa_search"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
        toolBudget: budget,
      });
    }

    await executeRuntimeTool({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      agentConfig: agentConfig(),
      toolCallId: "call_exa_over_budget",
      definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("exa_search") as RuntimeToolDefinition,
      args: { query: "too many" },
      getSandbox: async () => {
        throw new Error("sandbox should not hydrate");
      },
      workdir: "/home/user/workspace",
      env: env(),
      enabledTools: ["tool_help", "exa_search"],
      signal: new AbortController().signal,
      checkAbort: async () => {},
      toolBudget: budget,
    });

    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(db.state.toolUsage).toHaveLength(8);
    expect(JSON.parse(db.state.messages.at(-1)?.content ?? "{}")).toMatchObject({
      ok: false,
      error: { code: "tool_call_limit_exceeded", recoverable: true },
    });
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "tool.failed",
        payload: expect.objectContaining({
          toolCallId: "call_exa_over_budget",
          name: "exa_search",
          error: expect.objectContaining({ code: "tool_call_limit_exceeded" }),
        }),
      }),
    );
  });

  it("returns recoverable sandbox path failures as tool results without hydrating E2B", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => {
      throw new Error("sandbox should not hydrate");
    });

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        toolCallId: "call_read",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("read_file") as RuntimeToolDefinition,
        args: { path: "README.md" },
        getSandbox,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["read_file"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
        observabilityContext: {
          workspaceId: "wsp_123",
          userId: "user_123",
          agentId: "agt_123",
          modelProvider: "vercel-ai-gateway",
          modelName: "openai/gpt-5.4-mini",
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "invalid_sandbox_path",
        recoverable: true,
      }),
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "read_file",
      toolCallId: "call_read",
    });
    expect(db.state.messages.at(-1)?.content).toContain("invalid_sandbox_path");
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "tool.failed",
        payload: expect.objectContaining({
          toolCallId: "call_read",
          name: "read_file",
          error: expect.objectContaining({ code: "invalid_sandbox_path" }),
        }),
      }),
    );
    expect(observabilityMocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        event: "opencompany.runner_tool_failed",
        session_id: "ses_123",
        tool_call_id: "call_read",
        tool_name: "read_file",
        tool_kind: "sandbox",
      }),
    );
  });

  it("preflights edit_file paths before hydrating E2B", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => {
      throw new Error("sandbox should not hydrate");
    });

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        toolCallId: "call_edit",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("edit_file") as RuntimeToolDefinition,
        args: {
          path: "README.md",
          instructions: "Edit a bare path.",
          edits: [{ oldString: "old", newString: "new" }],
        },
        getSandbox,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["edit_file"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "invalid_sandbox_path",
        recoverable: true,
      }),
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "edit_file",
      toolCallId: "call_edit",
    });
  });

  it("returns recoverable sandbox execution failures as tool results after hydration", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => ({
      sandboxId: "sbx_123",
      files: {
        read: vi.fn(async () => {
          throw new Error("File not found");
        }),
      },
    }));

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        toolCallId: "call_read",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("read_file") as RuntimeToolDefinition,
        args: { path: "work/missing.txt" },
        getSandbox: getSandbox as never,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["read_file"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        message: "File not found",
        code: "tool_execution_failed",
        recoverable: true,
      },
    });

    expect(getSandbox).toHaveBeenCalledTimes(1);
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "read_file",
      toolCallId: "call_read",
    });
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "tool.failed",
        payload: expect.objectContaining({
          toolCallId: "call_read",
          error: expect.objectContaining({ code: "tool_execution_failed" }),
        }),
      }),
    );
  });

  it("injects repo-scoped GitHub auth into bound shell commands and redacts it", async () => {
    githubMocks.getGitHubWorkInstallationToken.mockResolvedValue("github_token_123");
    const db = createLeaseDb({
      runLeaseId: "run_123",
      githubRows: [
        {
          integrationId: "wint_123",
          fullName: "opencompany/web",
          installationId: "install_123",
          connectionLabel: "opencompany",
          connectionStatus: "connected",
          connectionStatusReason: null,
          resourceStatus: "available",
          resourceStatusReason: null,
        },
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => ({
      sandboxId: "sbx_123",
      commands: {
        run: vi.fn(
          async (
            command: string,
            options: {
              envs?: Record<string, string>;
              onStdout?: (data: string) => void;
              onStderr?: (data: string) => void;
            },
          ) => {
            if (command.includes("find brain")) return { stdout: "", stderr: "", exitCode: 0 };
            options.onStdout?.(`stdout ${options.envs?.GH_TOKEN ?? "missing"}\n`);
            options.onStderr?.(`stderr ${options.envs?.GIT_CONFIG_VALUE_0 ?? "missing"}\n`);
            return {
              stdout: `done ${options.envs?.GH_TOKEN ?? "missing"}`,
              stderr: `err ${options.envs?.GIT_CONFIG_VALUE_0 ?? "missing"}`,
              exitCode: 0,
            };
          },
        ),
      },
    }));
    const config = agentConfig({
      tools: [
        {
          id: "amp",
          type: "coding_agent",
          provider: "amp",
          label: "AMP",
          description: "Delegate coding work to Amp inside an E2B sandbox.",
          prCapable: true,
        },
      ],
      integrations: {
        github: {
          repositories: [
            {
              id: "opencompany-web",
              fullName: "opencompany/web",
              defaultBranch: "main",
              binding: {
                provider: "github",
                externalId: "repo_123",
                resourceType: "repository",
                displayName: "opencompany/web",
                connection: {
                  externalId: "install_123",
                  label: "opencompany",
                  accountName: "opencompany",
                  accountType: "Organization",
                },
              },
            },
          ],
        },
      },
    });

    await executeRuntimeTool({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      agentConfig: config,
      toolCallId: "toolu/with spaces",
      definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("shell") as RuntimeToolDefinition,
      args: { command: "cd work && gh pr list" },
      getSandbox: getSandbox as never,
      workdir: "/home/user/workspace",
      env: env(),
      enabledTools: ["shell"],
      signal: new AbortController().signal,
      checkAbort: async () => {},
    });

    const shellRun = (await getSandbox.mock.results[0]?.value).commands.run.mock.calls.find(
      ([command]: [string, unknown]) => command === "cd work && gh pr list",
    );
    expect(shellRun?.[1]).toMatchObject({
      envs: {
        GH_TOKEN: "github_token_123",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_REPO: "opencompany/web",
        GH_CONFIG_DIR: "/tmp/opencompany-gh-toolu-with-spaces",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: expect.stringMatching(/^Authorization: Basic /),
      },
    });
    expect(githubMocks.getGitHubWorkInstallationToken).toHaveBeenCalledWith({
      installationId: "install_123",
      repositoryFullNames: ["opencompany/web"],
    });
    expect(JSON.parse(db.state.messages.at(-1)?.content ?? "{}")).toEqual({
      stdout: "done [redacted]",
      stderr: "err [redacted]",
      exitCode: 0,
    });
    expect(publishTransientRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "command.output",
        payload: expect.objectContaining({
          delta: "stdout [redacted]\n",
        }),
      }),
    );
    expect(publishTransientRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "command.output",
        payload: expect.objectContaining({
          delta: "stderr [redacted]\n",
        }),
      }),
    );
  });

  it("leaves shell unauthenticated when no explicit repository binding exists", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const commands = {
      run: vi.fn(async (command: string, options: { envs?: Record<string, string> }) => {
        if (command.includes("find brain")) return { stdout: "", stderr: "", exitCode: 0 };
        return {
          stdout: options.envs?.GH_TOKEN ?? "no-token",
          stderr: "",
          exitCode: 0,
        };
      }),
    };
    const getSandbox = vi.fn(async () => ({ sandboxId: "sbx_123", commands }));

    await executeRuntimeTool({
      sessionId: "ses_123",
      assistantMessageId: "msg_assistant",
      runLeaseId: "run_123",
      runLeaseOwner: "runner-test",
      workspaceId: "wsp_123",
      agentConfig: agentConfig(),
      toolCallId: "call_shell",
      definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("shell") as RuntimeToolDefinition,
      args: { command: "env" },
      getSandbox: getSandbox as never,
      workdir: "/home/user/workspace",
      env: env(),
      enabledTools: ["shell"],
      signal: new AbortController().signal,
      checkAbort: async () => {},
    });

    const shellRun = commands.run.mock.calls.find(([command]) => command === "env");
    expect(shellRun?.[1]).not.toHaveProperty("envs");
    expect(githubMocks.getGitHubWorkInstallationToken).not.toHaveBeenCalled();
    expect(JSON.parse(db.state.messages.at(-1)?.content ?? "{}")).toMatchObject({
      stdout: "no-token",
      exitCode: 0,
    });
  });

  it("returns GitHub integration failures as recoverable shell results", async () => {
    const db = createLeaseDb({
      runLeaseId: "run_123",
      githubRows: [
        {
          integrationId: "wint_123",
          fullName: "opencompany/web",
          installationId: "install_123",
          connectionLabel: "opencompany",
          connectionStatus: "needs_reauth",
          connectionStatusReason: "Installation token failed with 401.",
          resourceStatus: "available",
          resourceStatusReason: null,
        },
      ],
    });
    dbMocks.getDb.mockReturnValue(db);
    const commands = {
      run: vi.fn(async (command: string) =>
        command.includes("find brain") ? { stdout: "", stderr: "", exitCode: 0 } : null,
      ),
    };
    const getSandbox = vi.fn(async () => ({ sandboxId: "sbx_123", commands }));
    const config = agentConfig({
      tools: [
        {
          id: "amp",
          type: "coding_agent",
          provider: "amp",
          label: "AMP",
          description: "Delegate coding work to Amp inside an E2B sandbox.",
          prCapable: true,
        },
      ],
      integrations: {
        github: {
          repositories: [
            { id: "opencompany-web", fullName: "opencompany/web", defaultBranch: "main" },
          ],
        },
      },
    });

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        workspaceId: "wsp_123",
        agentConfig: config,
        toolCallId: "call_shell",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("shell") as RuntimeToolDefinition,
        args: { command: "gh pr list" },
        getSandbox: getSandbox as never,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["shell"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        message:
          "GitHub connection opencompany is needs reauth. Reconnect GitHub or update the agent repository mention. Installation token failed with 401.",
        code: "tool_execution_failed",
        recoverable: true,
      }),
    });

    expect(commands.run.mock.calls.some(([command]) => command === "gh pr list")).toBe(false);
    expect(db.state.messages.at(-1)).toMatchObject({
      role: "tool",
      toolName: "shell",
      toolCallId: "call_shell",
    });
  });

  it("keeps sandbox hydration failures fatal", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => {
      throw new Error("E2B unavailable");
    });

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        toolCallId: "call_read",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("read_file") as RuntimeToolDefinition,
        args: { path: "work/file.txt" },
        getSandbox,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["read_file"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
      }),
    ).rejects.toThrow("E2B unavailable");

    expect(db.state.messages).toHaveLength(0);
    expect(appendRuntimeEvent).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "tool.failed" }),
    );
  });

  it("keeps aborted tool executions fatal", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const controller = new AbortController();
    controller.abort();
    const getSandbox = vi.fn(async () => ({
      sandboxId: "sbx_123",
    }));

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        toolCallId: "call_read",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("read_file") as RuntimeToolDefinition,
        args: { path: "work/file.txt" },
        getSandbox: getSandbox as never,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["read_file"],
        signal: controller.signal,
        checkAbort: async () => {},
      }),
    ).rejects.toThrow("Run aborted.");

    expect(getSandbox).not.toHaveBeenCalled();
    expect(db.state.messages).toHaveLength(0);
  });

  it("captures hosted Exa validation failures with searchable monitoring context", async () => {
    const db = createLeaseDb({ runLeaseId: "run_123" });
    dbMocks.getDb.mockReturnValue(db);
    const getSandbox = vi.fn(async () => {
      throw new Error("sandbox should not hydrate");
    });

    await expect(
      executeRuntimeTool({
        sessionId: "ses_123",
        assistantMessageId: "msg_assistant",
        runLeaseId: "run_123",
        runLeaseOwner: "runner-test",
        workspaceId: "wsp_123",
        agentConfig: agentConfig(),
        toolCallId: "call_exa",
        definition: RUNTIME_TOOL_DEFINITION_BY_NAME.get("exa_search") as RuntimeToolDefinition,
        args: {
          query: "OpenAI leadership",
          category: "people",
          excludeDomains: ["example.com"],
          startPublishedDate: "2026-01-01",
        },
        getSandbox,
        workdir: "/home/user/workspace",
        env: env(),
        enabledTools: ["tool_help", "exa_search"],
        signal: new AbortController().signal,
        checkAbort: async () => {},
        observabilityContext: {
          workspaceId: "wsp_123",
          userId: "user_123",
          agentId: "agt_123",
          modelProvider: "vercel-ai-gateway",
          modelName: "openai/gpt-5.4-mini",
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "tool_execution_failed",
        recoverable: true,
      }),
    });

    expect(getSandbox).not.toHaveBeenCalled();
    expect(observabilityMocks.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        event: "opencompany.runner_tool_failed",
        workspace_id: "wsp_123",
        user_id: "user_123",
        agent_id: "agt_123",
        session_id: "ses_123",
        message_id: "msg_assistant",
        tool_call_id: "call_exa",
        tool_name: "exa_search",
        tool_kind: "hosted",
        model_provider: "vercel-ai-gateway",
        model_name: "openai/gpt-5.4-mini",
        hosted_provider: "exa",
        hosted_operation: "search",
        tool_error_stage: "request_validation",
        tool_error_code: "exa_unsupported_category_filter_combination",
        exa_category: "people",
        exa_has_exclude_domains: true,
        exa_has_published_date_filter: true,
      }),
    );
    expect(db.state.toolUsage).toHaveLength(0);
    expect(db.state.messages).toHaveLength(1);
    expect(db.state.messages[0]).toMatchObject({
      role: "tool",
      toolName: "exa_search",
      toolCallId: "call_exa",
    });
  });
});
