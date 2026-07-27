import { CODEX_COMMAND_TOOL_PART_TYPE, type CodexUiMessagePart } from "@opencompany/agent-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import { runGoatCodexChatTurn, summarizeCodexChatRecoveryProgress } from "./goat-codex-chat";
import { GoatCodexChatHandoffError } from "./goat-codex-chat-errors";

const appServerMocks = vi.hoisted(() => ({
  runCodexAppServerTurn: vi.fn(),
}));

const attachmentMocks = vi.hoisted(() => ({
  downloadBlobBytes: vi.fn(),
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
  armSandboxActiveTimeoutById: vi.fn(),
  armSandboxIdleTimeout: vi.fn(),
  createOrConnectSandbox: vi.fn(),
}));

vi.mock("./codex-app-server", () => ({
  runCodexAppServerTurn: appServerMocks.runCodexAppServerTurn,
}));

vi.mock("./attachment-hydration", () => ({
  downloadBlobBytes: attachmentMocks.downloadBlobBytes,
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
  armSandboxActiveTimeoutById: sandboxMocks.armSandboxActiveTimeoutById,
  armSandboxIdleTimeout: sandboxMocks.armSandboxIdleTimeout,
  createOrConnectSandbox: sandboxMocks.createOrConnectSandbox,
  writeSandboxTextFiles: vi.fn(
    async (input: {
      sandbox: { files: { write: (files: unknown) => Promise<void> } };
      files: Array<{ path: string; content: unknown }>;
    }) =>
      input.sandbox.files.write(
        input.files.map((file) => ({ path: file.path, data: file.content })),
      ),
  ),
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
      cancelPendingInteractions: vi.fn(async () => false),
    });
    sandboxMocks.armSandboxActiveTimeoutById.mockResolvedValue(true);
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
    attachmentMocks.downloadBlobBytes.mockResolvedValue(Buffer.from("image bytes"));
  });

  it("materializes uploaded files and passes screenshots to Codex as local images", async () => {
    dbMocks.selectRows.push(
      [],
      [
        {
          attachments: [
            {
              id: "goat_chat_att_1",
              kind: "image",
              mediaType: "image/png",
              filename: "../screenshot one.png",
              sizeBytes: 11,
              blobPathname: "goat-chat/user_1/screenshot.png",
              blobUrl: "https://blob.test/goat-chat/user_1/screenshot.png",
            },
          ],
        },
      ],
    );
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);

    await runGoatCodexChatTurn({
      turn: codexTurn(),
      session: codexSession(),
      env: env({ blobReadWriteToken: "blob-token" }),
    });

    expect(attachmentMocks.downloadBlobBytes).toHaveBeenCalledWith(
      "https://blob.test/goat-chat/user_1/screenshot.png",
      "blob-token",
    );
    expect(sandbox.files.write).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining(
            "/.opencompany-goat/codex-chat-attachments/goat_codex_turn_1/goat_chat_att_1-screenshot_one.png",
          ),
          data: Buffer.from("image bytes"),
        }),
      ]),
    );
    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining(
          ".opencompany-goat/codex-chat-attachments/goat_codex_turn_1/goat_chat_att_1-screenshot_one.png",
        ),
        localImages: [
          {
            path: expect.stringContaining(
              "/.opencompany-goat/codex-chat-attachments/goat_codex_turn_1/goat_chat_att_1-screenshot_one.png",
            ),
            detail: "original",
          },
        ],
      }),
    );
  });

  it("materializes every active session skill and only invokes skills activated by this message", async () => {
    dbMocks.selectRows.push(
      [],
      [],
      [
        {
          skillId: "review-work",
          activatedMessageId: "goat_msg_user_previous",
          name: "Review work",
          description: "How reviews should happen.",
          instructions: "Review the existing implementation.",
          activatedAt: new Date("2026-07-10T11:00:00Z"),
        },
        {
          skillId: "coding-work",
          activatedMessageId: "goat_msg_user_1",
          name: "Coding work",
          description: "How coding work should happen.",
          instructions: "Inspect, implement, and verify.",
          activatedAt: new Date("2026-07-10T12:00:00Z"),
        },
      ],
    );
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);

    await runGoatCodexChatTurn({
      turn: codexTurn(),
      session: codexSession(),
      env: env(),
    });

    expect(sandbox.files.write).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          path: "/home/user/opencompany-goat/codex-chat/.agents/skills/review-work/SKILL.md",
          data: expect.stringContaining('name: "review-work"'),
        },
        {
          path: "/home/user/opencompany-goat/codex-chat/.agents/skills/coding-work/SKILL.md",
          data: expect.stringContaining('name: "coding-work"'),
        },
      ]),
    );
    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        skillFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        skills: [
          {
            name: "coding-work",
            path: "/home/user/opencompany-goat/codex-chat/.agents/skills/coding-work/SKILL.md",
          },
        ],
      }),
    );
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
        reasoningEffort: "xhigh",
      }),
    );
    expect(dbMocks.execute).toHaveBeenCalledOnce();
    expect(sqlText(dbMocks.execute.mock.calls[0]?.[0])).toContain("SET sandbox_timeout_armed_at");
    expect(sandboxMocks.armSandboxIdleTimeout).toHaveBeenCalledWith(sandbox, 300_000);
  });

  it("registers the Brain host tool only for a session pinned to its contract", async () => {
    dbMocks.selectRows.push([]);

    await runGoatCodexChatTurn({
      turn: codexTurn(),
      session: {
        ...codexSession(),
        brainRef: "brain_1",
        hostToolContractVersion: "goat-codex-brain.v1",
      },
      env: env(),
    });

    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining(
          "A read-only goat_brain tool is available for the Brain pinned to this chat.",
        ),
        dynamicTools: [
          expect.objectContaining({
            spec: expect.objectContaining({
              type: "function",
              name: "goat_brain",
            }),
          }),
        ],
      }),
    );
  });

  it("detaches without settling the turn and keeps the sandbox alive for handoff", async () => {
    dbMocks.selectRows.push([]);
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);
    appServerMocks.runCodexAppServerTurn.mockRejectedValueOnce(new GoatCodexChatHandoffError());

    await expect(
      runGoatCodexChatTurn({
        turn: codexTurn(),
        session: codexSession(),
        env: env(),
      }),
    ).resolves.toBe("handed_off");

    const projector = eventMocks.createGoatCodexChatProjector.mock.results[0]?.value;
    expect(projector.cancelPendingInteractions).toHaveBeenCalledOnce();
    expect(projector.finalize).not.toHaveBeenCalled();
    expect(projector.fail).not.toHaveBeenCalled();
    expect(projector.interrupted).not.toHaveBeenCalled();
    expect(sandboxMocks.armSandboxIdleTimeout).toHaveBeenCalledWith(sandbox, 600_000);
  });

  it("treats a setup timeout after shutdown starts as a handoff", async () => {
    dbMocks.selectRows.push([]);
    const sandbox = fakeSandbox("sbx_existing");
    let handoffRequested = false;
    const timeout = new Error("the operation timed out");
    timeout.name = "TimeoutError";
    sandbox.commands.run.mockImplementationOnce(async () => {
      handoffRequested = true;
      throw timeout;
    });
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);

    await expect(
      runGoatCodexChatTurn({
        turn: codexTurn(),
        session: codexSession(),
        env: env(),
        shouldAbort: () => (handoffRequested ? new GoatCodexChatHandoffError() : null),
      }),
    ).resolves.toBe("handed_off");

    const projector = eventMocks.createGoatCodexChatProjector.mock.results[0]?.value;
    expect(projector.cancelPendingInteractions).toHaveBeenCalledOnce();
    expect(projector.fail).not.toHaveBeenCalled();
    expect(appServerMocks.runCodexAppServerTurn).not.toHaveBeenCalled();
    expect(sandboxMocks.armSandboxIdleTimeout).toHaveBeenCalledWith(sandbox, 600_000);
  });

  it("does not park a sandbox after shutdown already released the lease", async () => {
    dbMocks.selectRows.push([]);
    dbMocks.execute.mockResolvedValueOnce({ rows: [] });
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);
    appServerMocks.runCodexAppServerTurn.mockRejectedValueOnce(new GoatCodexChatHandoffError());

    await expect(
      runGoatCodexChatTurn({
        turn: codexTurn(),
        session: codexSession(),
        env: env(),
      }),
    ).resolves.toBe("handed_off");

    expect(sandboxMocks.armSandboxIdleTimeout).not.toHaveBeenCalled();
  });

  it("restores the active sandbox timeout when lease handoff wins the parking race", async () => {
    dbMocks.selectRows.push([]);
    dbMocks.execute
      .mockResolvedValueOnce({ rows: [{ id: "owned" }] })
      .mockResolvedValueOnce({ rows: [] });
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);
    appServerMocks.runCodexAppServerTurn.mockRejectedValueOnce(new GoatCodexChatHandoffError());

    await expect(
      runGoatCodexChatTurn({
        turn: codexTurn(),
        session: codexSession(),
        env: env(),
      }),
    ).resolves.toBe("handed_off");

    expect(sandboxMocks.armSandboxIdleTimeout).toHaveBeenCalledWith(sandbox, 600_000);
    expect(sandboxMocks.armSandboxActiveTimeoutById).toHaveBeenCalledWith("sbx_existing");
  });

  it("persists first-turn engine ids before a handoff can detach the proxy", async () => {
    dbMocks.selectRows.push([]);
    appServerMocks.runCodexAppServerTurn.mockImplementationOnce(
      async (input: {
        onEngineSessionId?: (threadId: string) => Promise<void>;
        onEngineTurnId?: (turnId: string) => Promise<void>;
      }) => {
        await input.onEngineSessionId?.("thread_new");
        await input.onEngineTurnId?.("turn_new");
        throw new GoatCodexChatHandoffError();
      },
    );

    await expect(
      runGoatCodexChatTurn({
        turn: codexTurn(),
        session: { ...codexSession(), codexThreadId: null },
        env: env(),
      }),
    ).resolves.toBe("handed_off");

    const statements = dbMocks.execute.mock.calls.map(([query]) => sqlText(query));
    expect(statements).toContainEqual(expect.stringContaining("codex_thread_id"));
    expect(statements).toContainEqual(expect.stringContaining("codex_turn_id"));
  });

  it("restarts the daemon before recovery when a dead proxy owned a user question", async () => {
    dbMocks.selectRows.push([]);
    const projector = {
      push: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      interrupted: vi.fn(async () => undefined),
      cancelPendingInteractions: vi.fn(async () => true),
    };
    eventMocks.createGoatCodexChatProjector.mockReturnValueOnce(projector);

    await runGoatCodexChatTurn({
      turn: { ...codexTurn(), attempts: 2, codexTurnId: "turn_existing" },
      session: codexSession(),
      env: env(),
      recovery: { reason: "lease_reclaimed" },
    });

    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingEngineTurnId: "turn_existing",
        reattachExistingTurn: true,
        forceRestartForRecovery: true,
      }),
    );
  });

  it("restarts the daemon before recovering a pending host tool call", async () => {
    dbMocks.selectRows.push([]);
    eventMocks.loadCodexChatAssistantMessageParts.mockResolvedValueOnce([
      {
        type: "dynamic-tool",
        toolName: "codex_dynamic_tool",
        toolCallId: "dynamic_1",
        state: "input-available",
        input: { label: "Brain", tool: "goat_brain" },
      },
    ]);

    await runGoatCodexChatTurn({
      turn: { ...codexTurn(), attempts: 2, codexTurnId: "turn_existing" },
      session: {
        ...codexSession(),
        brainRef: "brain_1",
        hostToolContractVersion: "goat-codex-brain.v1",
      },
      env: env(),
      recovery: { reason: "lease_reclaimed" },
    });

    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingEngineTurnId: "turn_existing",
        reattachExistingTurn: true,
        forceRestartForRecovery: true,
      }),
    );
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
    then: <TResult1 = unknown[], TResult2 = never>(
      onFulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(rows.shift() ?? []).then(onFulfilled, onRejected),
    execute,
  };
  return builder;
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        const value = (chunk as { value?: unknown }).value;
        return Array.isArray(value) ? value.join("") : String(value ?? "");
      }
      if (chunk && typeof chunk === "object" && "queryChunks" in chunk) return sqlText(chunk);
      return "";
    })
    .join("");
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
    brainRef: null,
    hostToolContractVersion: null,
    sandboxId: "sbx_existing",
    codexThreadId: "thread_existing",
    activeTurnId: "goat_codex_turn_1",
    status: "running",
    error: null,
    sandboxTimeoutArmedAt: null,
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
    recoveryAttempts: 0,
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
