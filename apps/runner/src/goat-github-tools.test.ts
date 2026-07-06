import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import { createGoatGitHubToolSession } from "./goat-github-tools";

const mocks = vi.hoisted(() => ({
  dbLimit: vi.fn(),
  createOrConnectSandbox: vi.fn(),
  cloneGitHubRepositoryIntoWorkdir: vi.fn(),
  killSandbox: vi.fn(),
  getGitHubWorkInstallationToken: vi.fn(),
  createDraftPullRequest: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: () => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: mocks.dbLimit,
          })),
        })),
      })),
    })),
  }),
}));

vi.mock("./sandbox", () => ({
  createOrConnectSandbox: mocks.createOrConnectSandbox,
  cloneGitHubRepositoryIntoWorkdir: mocks.cloneGitHubRepositoryIntoWorkdir,
  killSandbox: mocks.killSandbox,
  commandExitResult: vi.fn(() => null),
}));

vi.mock("./github", () => ({
  getGitHubWorkInstallationToken: mocks.getGitHubWorkInstallationToken,
  createDraftPullRequest: mocks.createDraftPullRequest,
}));

describe("Goat GitHub tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbLimit.mockResolvedValue([
      {
        integrationId: "gint_1",
        installationId: "inst_1",
        integrationStatus: "connected",
        resourceStatus: "available",
        name: "octo/private-repo",
        metadata: { defaultBranch: "main", private: true },
      },
    ]);
    mocks.getGitHubWorkInstallationToken.mockResolvedValue("github-secret-token");
    mocks.cloneGitHubRepositoryIntoWorkdir.mockResolvedValue(undefined);
    mocks.killSandbox.mockResolvedValue(true);
  });

  it("clones a granted repo, redacts shell output, and records sandbox usage on cleanup", async () => {
    const commandRun = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: "token=github-secret-token",
        stderr: "done",
        exitCode: 0,
      });
    mocks.createOrConnectSandbox.mockResolvedValue({
      sandboxId: "sbx_1",
      commands: { run: commandRun },
    });
    const recordSandboxUsage = vi.fn(async () => {});
    const session = createGoatGitHubToolSession({
      userWorkosId: "user_123",
      env: env(),
      signal: new AbortController().signal,
      recordSandboxUsage,
    });

    await expect(
      session.execute({
        name: "github_clone_repository",
        toolInput: { repository: "octo/private-repo" },
        toolCallId: "call_clone",
        messageId: "tool_msg_clone",
      }),
    ).resolves.toMatchObject({
      ok: true,
      repository: "octo/private-repo",
      sandboxId: "sbx_1",
    });

    await expect(
      session.execute({
        name: "github_shell",
        toolInput: { command: "gh pr list" },
        toolCallId: "call_shell",
        messageId: "tool_msg_shell",
      }),
    ).resolves.toMatchObject({
      ok: true,
      stdout: "token=[redacted]",
    });

    expect(commandRun).toHaveBeenLastCalledWith(
      expect.stringContaining("gh pr list"),
      expect.objectContaining({
        envs: expect.objectContaining({
          GH_TOKEN: "github-secret-token",
          GH_REPO: "octo/private-repo",
          GIT_TERMINAL_PROMPT: "0",
        }),
      }),
    );

    await session.cleanup();

    expect(recordSandboxUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "tool_msg_shell",
        sandboxId: "sbx_1",
        rawMetrics: { repository: "octo/private-repo" },
      }),
    );
    expect(mocks.killSandbox).toHaveBeenCalledWith("sbx_1");
  });

  it("requires cloning before shell commands", async () => {
    const session = createGoatGitHubToolSession({
      userWorkosId: "user_123",
      env: env(),
      signal: new AbortController().signal,
    });

    await expect(
      session.execute({
        name: "github_shell",
        toolInput: { command: "pwd" },
        toolCallId: "call_shell",
      }),
    ).rejects.toThrow("Call github_clone_repository before using GitHub shell");
  });
});

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: undefined,
    publicUrl: undefined,
    llmBrokerEnabled: true,
    integrationCredentialEncryptionKey: Buffer.alloc(32, 0),
    exaApiKey: "exa",
    xApiBearerToken: undefined,
    supadataApiKey: undefined,
    ampApiKey: undefined,
    googleOAuthClientId: undefined,
    googleOAuthClientSecret: undefined,
    e2bTemplate: "goat",
    ampE2bTemplate: undefined,
    codexE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
    blobReadWriteToken: undefined,
    opencodeTimeoutMs: 120_000,
    codexTimeoutMs: 120_000,
    codexModel: "gpt-5.5",
    toolArgRepairEnabled: true,
    jobLeaseTtlMs: 300_000,
    jobMaxLeaseBusyAttempts: 10,
    goatTaskWorkerEnabled: false,
    workerConcurrency: 1,
    port: 3040,
    allowedOrigins: [],
    instanceId: "runner_1",
    ...overrides,
  };
}
