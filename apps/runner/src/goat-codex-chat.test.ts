import { CODEX_COMMAND_TOOL_PART_TYPE, type CodexUiMessagePart } from "@opencompany/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import { runGoatCodexChatTurn, summarizeCodexChatRecoveryProgress } from "./goat-codex-chat";

const appServerMocks = vi.hoisted(() => ({
  runCodexAppServerTurn: vi.fn(),
}));

const codexAuthMocks = vi.hoisted(() => ({
  loadGoatCodexCliAuth: vi.fn(),
  persistRefreshedGoatCodexAuth: vi.fn(),
}));

const codexToolMocks = vi.hoisted(() => ({
  ensureCodexInstalled: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  execute: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  createGoatCodexChatProjector: vi.fn(),
  loadCodexChatAssistantMessageParts: vi.fn(),
}));

const sandboxMocks = vi.hoisted(() => ({
  armSandboxIdleTimeout: vi.fn(),
  createOrConnectSandbox: vi.fn(),
}));

vi.mock("./codex-app-server", () => ({
  runCodexAppServerTurn: appServerMocks.runCodexAppServerTurn,
}));

vi.mock("./codex-tool", () => ({
  ensureCodexInstalled: codexToolMocks.ensureCodexInstalled,
}));

vi.mock("./coding-agent-shared", () => ({
  createKnownSecretRedactor: () => (value: string) => value,
  gitAuthHeader: (token: string) => `Authorization: Basic ${token}`,
}));

vi.mock("./db", () => ({
  getDb: () => queryBuilder(dbMocks.selectRows, dbMocks.execute),
}));

vi.mock("./github", () => ({
  getGitHubWorkInstallationToken: vi.fn(),
}));

vi.mock("./goat-codex", () => ({
  loadGoatCodexCliAuth: codexAuthMocks.loadGoatCodexCliAuth,
  persistRefreshedGoatCodexAuth: codexAuthMocks.persistRefreshedGoatCodexAuth,
}));

vi.mock("./goat-codex-chat-events", () => ({
  createGoatCodexChatProjector: eventMocks.createGoatCodexChatProjector,
  loadCodexChatAssistantMessageParts: eventMocks.loadCodexChatAssistantMessageParts,
}));

vi.mock("./sandbox", () => ({
  armSandboxIdleTimeout: sandboxMocks.armSandboxIdleTimeout,
  createOrConnectSandbox: sandboxMocks.createOrConnectSandbox,
}));

describe("runGoatCodexChatTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectRows.length = 0;
    dbMocks.execute.mockResolvedValue({ rows: [{ id: "updated" }] });
    codexAuthMocks.loadGoatCodexCliAuth.mockResolvedValue({
      kind: "api",
      baseUrl: "https://api.openai.test/v1",
      apiKeyEnvVar: "CODEX_API_KEY",
      apiKeyValue: "codex_secret",
      brokered: false,
    });
    codexAuthMocks.persistRefreshedGoatCodexAuth.mockResolvedValue(undefined);
    codexToolMocks.ensureCodexInstalled.mockResolvedValue(undefined);
    eventMocks.loadCodexChatAssistantMessageParts.mockResolvedValue([]);
    eventMocks.createGoatCodexChatProjector.mockReturnValue({
      push: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      interrupted: vi.fn(async () => undefined),
    });
    sandboxMocks.armSandboxIdleTimeout.mockResolvedValue(true);
    sandboxMocks.createOrConnectSandbox.mockResolvedValue(fakeSandbox("sbx_existing"));
    appServerMocks.runCodexAppServerTurn.mockResolvedValue({
      sessionId: "thread_existing",
      status: "success",
      result: "Done.",
      error: null,
      usage: null,
      goal: null,
    });
  });

  it("reuses a stored sandbox id and rearms the 5 minute idle pause window after the turn", async () => {
    dbMocks.selectRows.push([]);
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);

    await runGoatCodexChatTurn({
      turn: codexTurn(),
      session: codexSession(),
      env: env(),
    });

    expect(sandboxMocks.createOrConnectSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx_existing",
        template: "codex",
        idleTimeoutMs: 300_000,
      }),
    );
    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingEngineSessionId: "thread_existing",
        codexWorkRoot: "/home/user/opencompany-goat/codex-chat",
      }),
    );
    expect(dbMocks.execute).not.toHaveBeenCalled();
    expect(sandboxMocks.armSandboxIdleTimeout).toHaveBeenCalledWith(sandbox, 300_000);
  });
});

describe("summarizeCodexChatRecoveryProgress", () => {
  it("summarizes persisted assistant progress for a recovery prompt", () => {
    const parts: CodexUiMessagePart[] = [
      { type: "text", text: "I inspected the repo." },
      {
        type: CODEX_COMMAND_TOOL_PART_TYPE,
        toolCallId: "cmd_1",
        state: "output-available",
        input: { command: "bun test" },
        output: { status: "completed", exitCode: 0 },
      },
      {
        type: CODEX_COMMAND_TOOL_PART_TYPE,
        toolCallId: "cmd_2",
        state: "input-available",
        input: { command: "git push origin branch" },
      },
      {
        type: "dynamic-tool",
        toolName: "codex_goal",
        toolCallId: "goal_1",
        state: "output-available",
        input: { objective: "Open a PR" },
        output: { status: "active", objective: "Open a PR" },
      },
    ];

    expect(summarizeCodexChatRecoveryProgress(parts)).toContain("Assistant: I inspected the repo.");
    expect(summarizeCodexChatRecoveryProgress(parts)).toContain(
      "Command completed, exit 0: bun test",
    );
    expect(summarizeCodexChatRecoveryProgress(parts)).toContain(
      "Command started without a persisted result: git push origin branch",
    );
    expect(summarizeCodexChatRecoveryProgress(parts)).toContain("codex_goal active: Open a PR");
  });
});

function queryBuilder(rows: unknown[][], execute: ReturnType<typeof vi.fn>) {
  const builder = {
    select: () => builder,
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: async () => rows.shift() ?? [],
    execute,
  };
  return builder;
}

function fakeSandbox(sandboxId: string) {
  return {
    sandboxId,
    commands: {
      run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    },
    files: {
      write: vi.fn(async () => undefined),
      read: vi.fn(async () => "{}"),
    },
  };
}

function codexSession() {
  const now = new Date("2026-07-10T12:00:00Z");
  return {
    id: "goat_codex_chat_1",
    userWorkosId: "user_1",
    chatSessionId: "goat_chat_1",
    model: "gpt-5.5",
    sandboxId: "sbx_existing",
    codexThreadId: "thread_existing",
    activeTurnId: "goat_codex_turn_1",
    status: "running",
    error: null,
    createdAt: now,
    updatedAt: now,
  } as const;
}

function codexTurn() {
  const now = new Date("2026-07-10T12:00:00Z");
  return {
    id: "goat_codex_turn_1",
    userWorkosId: "user_1",
    codexChatSessionId: "goat_codex_chat_1",
    chatSessionId: "goat_chat_1",
    userMessageId: "goat_msg_user_1",
    assistantMessageId: "goat_msg_assistant_1",
    codexTurnId: null,
    status: "running",
    prompt: "Continue the work.",
    settings: {},
    error: null,
    interruptRequestedAt: null,
    attempts: 1,
    leaseId: "lease_1",
    leaseOwner: "runner_1",
    leaseExpiresAt: new Date("2026-07-10T12:05:00Z"),
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  } as const;
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
    goatCodexChatIdleTimeoutMs: 300_000,
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
