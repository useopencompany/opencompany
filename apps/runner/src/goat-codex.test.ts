import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import { runGoatCodexTask } from "./goat-codex";

const dbRows = vi.hoisted(() => [] as unknown[]);
const order = vi.hoisted(() => [] as string[]);

const appServerMocks = vi.hoisted(() => ({
  runCodexAppServerTurn: vi.fn(),
}));

const codexAuthMocks = vi.hoisted(() => ({
  loadGoatCodexCredential: vi.fn(),
  markGoatCodexCredentialNeedsReauth: vi.fn(),
  rotateGoatCodexCredential: vi.fn(),
}));

const codexToolMocks = vi.hoisted(() => ({
  codexApiKeyFallbackEnabled: vi.fn(),
  ensureCodexInstalled: vi.fn(),
}));

const githubMocks = vi.hoisted(() => ({
  createDraftPullRequest: vi.fn(),
  getGitHubWorkInstallationToken: vi.fn(),
}));

const sandboxMocks = vi.hoisted(() => ({
  cloneGitHubRepositoryIntoWorkdir: vi.fn(),
  createOrConnectSandbox: vi.fn(),
  killSandbox: vi.fn(),
}));

vi.mock("@opencompany/db/goat-codex-auth", () => ({
  loadGoatCodexCredential: codexAuthMocks.loadGoatCodexCredential,
  markGoatCodexCredentialNeedsReauth: codexAuthMocks.markGoatCodexCredentialNeedsReauth,
  rotateGoatCodexCredential: codexAuthMocks.rotateGoatCodexCredential,
}));

vi.mock("./codex-app-server", () => ({
  runCodexAppServerTurn: appServerMocks.runCodexAppServerTurn,
}));

vi.mock("./codex-tool", () => {
  return {
    codexApiKeyFallbackEnabled: codexToolMocks.codexApiKeyFallbackEnabled,
    ensureCodexInstalled: codexToolMocks.ensureCodexInstalled,
  };
});

vi.mock("./db", () => ({
  getDb: () => queryBuilder(dbRows),
}));

vi.mock("./github", () => ({
  createDraftPullRequest: githubMocks.createDraftPullRequest,
  getGitHubWorkInstallationToken: githubMocks.getGitHubWorkInstallationToken,
}));

vi.mock("./sandbox", () => ({
  cloneGitHubRepositoryIntoWorkdir: sandboxMocks.cloneGitHubRepositoryIntoWorkdir,
  createOrConnectSandbox: sandboxMocks.createOrConnectSandbox,
  killSandbox: sandboxMocks.killSandbox,
}));

describe("runGoatCodexTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbRows.length = 0;
    order.length = 0;
    codexAuthMocks.loadGoatCodexCredential.mockResolvedValue(null);
    codexToolMocks.codexApiKeyFallbackEnabled.mockReturnValue(true);
    codexToolMocks.ensureCodexInstalled.mockResolvedValue(undefined);
    githubMocks.getGitHubWorkInstallationToken.mockResolvedValue("gh_secret_token");
    githubMocks.createDraftPullRequest.mockResolvedValue({
      html_url: "https://github.com/octo/repo/pull/123",
    });
    sandboxMocks.cloneGitHubRepositoryIntoWorkdir.mockResolvedValue(undefined);
    sandboxMocks.killSandbox.mockResolvedValue(undefined);
    sandboxMocks.createOrConnectSandbox.mockResolvedValue(fakeSandbox());
    appServerMocks.runCodexAppServerTurn.mockResolvedValue({
      sessionId: "thread_new",
      status: "success",
      result: "Codex completed.",
      error: null,
      goal: null,
      usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 3 },
    });
  });

  it("starts an app-server thread for a first Goat Codex task", async () => {
    const onEngineSessionId = vi.fn(async (sessionId: string) => {
      order.push(`persist:${sessionId}`);
    });
    const onOutput = vi.fn();

    const result = await runGoatCodexTask({
      userWorkosId: "user_1",
      taskId: "goat_task_1",
      messageId: "msg_1",
      prompt: "Fix the issue.",
      systemPrompt: "Use Codex.",
      model: "openai/gpt-5.5",
      env: env(),
      signal: new AbortController().signal,
      onEngineSessionId,
      onOutput,
    });

    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        codexWorkRoot: "/home/user/opencompany-goat/codex",
        codexHome: "/home/user/.opencompany-goat/codex-home",
        skillFingerprint: "goat-codex-v1",
        model: "gpt-5.5",
        reasoningEffort: "high",
        planModeReasoningEffort: null,
        goalMode: null,
        existingEngineSessionId: null,
        githubAuth: { githubToken: null, githubAuthHeader: null },
      }),
    );
    expect(appServerMocks.runCodexAppServerTurn.mock.calls[0]![0].task).toContain("Use Codex.");
    expect(appServerMocks.runCodexAppServerTurn.mock.calls[0]![0].task).toContain("Fix the issue.");
    expect(onEngineSessionId).toHaveBeenCalledWith("thread_new");
    expect(result).toMatchObject({
      content: "Codex completed.",
      model: "gpt-5.5",
      sandboxId: "sbx_goat",
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
      },
    });

    await appServerMocks.runCodexAppServerTurn.mock.calls[0]![0].onActivity("working");
    expect(onOutput).toHaveBeenCalledWith("working");
  });

  it("resumes an existing app-server thread id and preserves configured reasoning effort", async () => {
    await runGoatCodexTask({
      userWorkosId: "user_1",
      taskId: "goat_task_1",
      messageId: "msg_1",
      prompt: "Continue.",
      systemPrompt: "Use Codex.",
      model: "openai/gpt-5.5",
      existingEngineSessionId: "thread_existing",
      reasoningEffort: "medium",
      env: env(),
      signal: new AbortController().signal,
    });

    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingEngineSessionId: "thread_existing",
        reasoningEffort: "medium",
      }),
    );
  });

  it("passes goal mode into app-server execution and formats terminal goal status", async () => {
    appServerMocks.runCodexAppServerTurn.mockResolvedValueOnce({
      sessionId: "thread_new",
      status: "success",
      result: "Codex completed.",
      error: null,
      goal: {
        objective: "Fix tests and verify they pass.",
        status: "complete",
        tokenBudget: 200_000,
        tokensUsed: 12_345,
        timeUsedSeconds: 67,
      },
      usage: null,
    });

    const result = await runGoatCodexTask({
      userWorkosId: "user_1",
      taskId: "goat_task_1",
      messageId: "msg_1",
      prompt: "Fix the tests.",
      systemPrompt: "Use Codex.",
      model: "openai/gpt-5.5",
      goalMode: {
        objective: "Fix tests and verify they pass.",
        tokenBudget: 200_000,
      },
      env: env(),
      signal: new AbortController().signal,
    });

    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        goalMode: {
          objective: "Fix tests and verify they pass.",
          tokenBudget: 200_000,
        },
      }),
    );
    expect(appServerMocks.runCodexAppServerTurn.mock.calls[0]![0].task).toContain("<goal_mode>");
    expect(appServerMocks.runCodexAppServerTurn.mock.calls[0]![0].task).toContain(
      "Objective: Fix tests and verify they pass.",
    );
    expect(result.content).toContain("Goal status: complete - budget 200000 - used 12345 - 67s");
    expect(result.goal).toMatchObject({
      status: "complete",
      tokenBudget: 200_000,
    });
  });

  it("persists the returned thread id before repository diff and PR work", async () => {
    dbRows.push(repositoryRow());
    const sandbox = fakeSandbox();
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);

    await runGoatCodexTask({
      userWorkosId: "user_1",
      taskId: "goat_task_1",
      messageId: "msg_1",
      prompt: "Fix octo/repo.",
      systemPrompt: "Use Codex.",
      model: "openai/gpt-5.5",
      repository: "octo/repo",
      createPullRequest: true,
      env: env(),
      signal: new AbortController().signal,
      onEngineSessionId: async (sessionId) => {
        order.push(`persist:${sessionId}`);
      },
    });

    expect(order).toContain("persist:thread_new");
    expect(order.indexOf("persist:thread_new")).toBeLessThan(order.indexOf("diff-status"));
    expect(sandboxMocks.cloneGitHubRepositoryIntoWorkdir).toHaveBeenCalledWith(
      expect.objectContaining({
        workdir: "/home/user/opencompany-goat/codex",
        repositoryFullName: "octo/repo",
        defaultBranch: "main",
        githubToken: "gh_secret_token",
      }),
    );
    expect(githubMocks.createDraftPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "98765",
        repositoryFullName: "octo/repo",
        base: "main",
        body: expect.stringContaining("Fix octo/repo."),
      }),
    );
    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        githubAuth: expect.objectContaining({
          githubToken: "gh_secret_token",
          githubAuthHeader: expect.stringContaining("Authorization: Basic"),
        }),
      }),
    );
  });

  it("canonicalizes GitHub URL repositories through the connected resource", async () => {
    dbRows.push(repositoryRow({ name: "octo/repo" }));

    await runGoatCodexTask({
      userWorkosId: "user_1",
      taskId: "goat_task_1",
      messageId: "msg_1",
      prompt: "Fix https://github.com/OCTO/repo.git.",
      systemPrompt: "Use Codex.",
      model: "openai/gpt-5.5",
      repository: "https://github.com/OCTO/repo.git",
      env: env(),
      signal: new AbortController().signal,
    });

    expect(githubMocks.getGitHubWorkInstallationToken).toHaveBeenCalledWith({
      installationId: "98765",
      repositoryFullName: "octo/repo",
    });
    expect(sandboxMocks.cloneGitHubRepositoryIntoWorkdir).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryFullName: "octo/repo",
      }),
    );
  });

  it("validates repository access before creating a sandbox", async () => {
    await expect(
      runGoatCodexTask({
        userWorkosId: "user_1",
        taskId: "goat_task_1",
        messageId: "msg_1",
        prompt: "Fix octo/private.",
        systemPrompt: "Use Codex.",
        model: "openai/gpt-5.5",
        repository: "octo/private",
        env: env(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Connect GitHub in Goat settings");

    expect(sandboxMocks.createOrConnectSandbox).not.toHaveBeenCalled();
  });

  it("refreshes ChatGPT auth from the app-server Codex home", async () => {
    const authJson = { OPENAI_API_KEY: "chatgpt_secret" };
    codexAuthMocks.loadGoatCodexCredential.mockResolvedValueOnce({
      status: "connected",
      authJson,
    });
    const sandbox = fakeSandbox();
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);

    await runGoatCodexTask({
      userWorkosId: "user_1",
      taskId: "goat_task_1",
      messageId: "msg_1",
      prompt: "Run.",
      systemPrompt: "Use Codex.",
      model: "openai/gpt-5.5",
      env: env(),
      signal: new AbortController().signal,
    });

    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { kind: "chatgpt", authJson, brokered: false },
      }),
    );
    expect(sandbox.files.writes.get("/home/user/.opencompany-goat/codex-home/auth.json")).toBe(
      JSON.stringify(authJson),
    );
    expect(codexAuthMocks.rotateGoatCodexCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        authJson,
      }),
    );
  });
});

function queryBuilder(rows: unknown[]) {
  const builder = {
    select: () => builder,
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    limit: async () => rows,
  };
  return builder;
}

function fakeSandbox() {
  const writes = new Map<string, string>();
  const commands: string[] = [];
  return {
    sandboxId: "sbx_goat",
    files: {
      writes,
      write: async (path: string, content: string) => {
        writes.set(path, content);
      },
      read: async (path: string) => {
        if (!writes.has(path)) throw new Error(`Missing sandbox file ${path}`);
        return writes.get(path)!;
      },
    },
    commands: {
      commands,
      run: async (command: string) => {
        commands.push(command);
        if (command.includes("git status --short")) {
          order.push("diff-status");
          return { stdout: " M src/index.ts\n", stderr: "", exitCode: 0 };
        }
        if (command.includes("git diff HEAD --stat")) {
          return { stdout: " src/index.ts | 2 +-\n", stderr: "", exitCode: 0 };
        }
        if (command.includes("git diff HEAD | head -400")) {
          return { stdout: "diff --git a/src/index.ts b/src/index.ts\n", stderr: "", exitCode: 0 };
        }
        if (command.includes("git branch --show-current")) {
          return { stdout: "main\n", stderr: "", exitCode: 0 };
        }
        if (command.includes("git rev-list --count")) {
          return { stdout: "0\n", stderr: "", exitCode: 0 };
        }
        if (command.includes("gh pr view")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };
}

function repositoryRow(overrides: Partial<ReturnType<typeof baseRepositoryRow>> = {}) {
  return {
    ...baseRepositoryRow(),
    ...overrides,
  };
}

function baseRepositoryRow() {
  return {
    integrationId: "goat_integration_1",
    installationId: "98765",
    integrationStatus: "connected",
    resourceStatus: "available",
    name: "octo/repo",
    metadata: { defaultBranch: "main" },
  };
}

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: "codex_api_secret",
    publicUrl: undefined,
    llmBrokerEnabled: true,
    integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
    exaApiKey: "exa",
    goatBrowserEnabled: false,
    agentBrowserProvider: undefined,
    browserlessApiKey: undefined,
    browserlessApiUrl: undefined,
    browserlessTtl: undefined,
    browserlessStealth: undefined,
    xApiBearerToken: undefined,
    supadataApiKey: undefined,
    ampApiKey: undefined,
    e2bTemplate: undefined,
    ampE2bTemplate: undefined,
    codexE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    opencodeTimeoutMs: 1_200_000,
    codexTimeoutMs: 1_200_000,
    codexModel: "gpt-5.5",
    toolArgRepairEnabled: false,
    jobLeaseTtlMs: 300_000,
    jobMaxLeaseBusyAttempts: 10,
    goatTaskWorkerEnabled: false,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner_1",
    ...overrides,
  };
}
