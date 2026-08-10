import { CODEX_COMMAND_TOOL_PART_TYPE, type CodexUiMessagePart } from "@opencompany/agent-runtime";
import type { GoatWorkflowHarnessSpec } from "@opencompany/db/goat-harness";
import type { GoatTask } from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerRequest } from "./codex-app-server";
import type { RunnerEnv } from "./env";
import {
  CODEX_CHAT_HOME,
  claimCodexChatRecovery,
  createTurnAbortCheck,
  GoatCodexChatInterruptedError,
  runGoatCodexChatTurn,
  summarizeCodexChatRecoveryProgress,
} from "./goat-codex-chat";
import {
  GoatCodexChatHandoffError,
  GoatCodexChatRetryableInfrastructureError,
} from "./goat-codex-chat-errors";

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
  isRetryableSandboxAcquisitionError: vi.fn(),
}));

const repoBootstrapMocks = vi.hoisted(() => ({
  loadGoatRepositoryBootstrap: vi.fn(),
  stageGoatRepositoryBootstrap: vi.fn(),
}));

vi.mock("./codex-app-server", () => ({
  runCodexAppServerTurn: appServerMocks.runCodexAppServerTurn,
}));

vi.mock("./attachment-hydration", () => ({
  downloadBlobBytes: attachmentMocks.downloadBlobBytes,
}));

vi.mock("./codex-cli", () => ({
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
  isRetryableSandboxAcquisitionError: sandboxMocks.isRetryableSandboxAcquisitionError,
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

vi.mock("./repo-bootstrap", () => ({
  loadGoatRepositoryBootstrap: repoBootstrapMocks.loadGoatRepositoryBootstrap,
  stageGoatRepositoryBootstrap: repoBootstrapMocks.stageGoatRepositoryBootstrap,
}));

describe("createTurnAbortCheck", () => {
  beforeEach(() => {
    dbMocks.selectRows.length = 0;
  });

  it("prioritizes a durable user interrupt over a concurrent runner handoff", async () => {
    dbMocks.selectRows.push([
      {
        interruptRequestedAt: new Date("2026-07-10T12:00:01.000Z"),
        leaseId: "lease_1",
        leaseOwner: "runner_1",
      },
    ]);
    const checkAbort = createTurnAbortCheck({
      turnId: "turn_1",
      leaseId: "lease_1",
      leaseOwner: "runner_1",
      shouldAbort: () => new GoatCodexChatHandoffError(),
    });

    await expect(checkAbort()).rejects.toBeInstanceOf(GoatCodexChatInterruptedError);
  });

  it("still hands off when the durable turn has no interrupt request", async () => {
    dbMocks.selectRows.push([
      {
        interruptRequestedAt: null,
        leaseId: "lease_1",
        leaseOwner: "runner_1",
      },
    ]);
    const checkAbort = createTurnAbortCheck({
      turnId: "turn_1",
      leaseId: "lease_1",
      leaseOwner: "runner_1",
      shouldAbort: () => new GoatCodexChatHandoffError(),
    });

    await expect(checkAbort()).rejects.toBeInstanceOf(GoatCodexChatHandoffError);
  });
});

describe("runGoatCodexChatTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectRows.length = 0;
    dbMocks.execute.mockReset().mockResolvedValue({ rows: [{ id: "updated" }] });
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
    sandboxMocks.isRetryableSandboxAcquisitionError.mockReturnValue(false);
    repoBootstrapMocks.loadGoatRepositoryBootstrap.mockResolvedValue({
      configs: [],
      promptFragment: "",
      secretValues: [],
    });
    repoBootstrapMocks.stageGoatRepositoryBootstrap.mockResolvedValue(undefined);
    appServerMocks.runCodexAppServerTurn.mockImplementation(
      async (input: { onBeforeEngineTurnStart?: (turnIds: string[]) => Promise<void> }) => {
        await input.onBeforeEngineTurnStart?.(["turn_before"]);
        return {
          sessionId: "thread_existing",
          status: "success",
          result: "Done.",
          error: null,
          usage: null,
          goal: null,
        };
      },
    );
    attachmentMocks.downloadBlobBytes.mockResolvedValue(Buffer.from("image bytes"));
  });

  it("fails closed for native Codex approval and permission requests", async () => {
    appServerMocks.runCodexAppServerTurn.mockImplementationOnce(
      async (input: {
        onBeforeEngineTurnStart?: (turnIds: string[]) => Promise<void>;
        onServerRequest?: (request: CodexAppServerRequest) => Promise<Record<string, unknown>>;
      }) => {
        await input.onBeforeEngineTurnStart?.(["turn_before"]);
        expect(input.onServerRequest).toBeTypeOf("function");
        const onServerRequest = input.onServerRequest!;
        await expect(
          onServerRequest({
            id: "approval_1",
            method: "item/commandExecution/requestApproval",
            params: { threadId: "thread_1", turnId: "turn_1", itemId: "cmd_1" },
          }),
        ).resolves.toEqual({ decision: "decline" });
        await expect(
          onServerRequest({
            id: "approval_2",
            method: "item/fileChange/requestApproval",
            params: { threadId: "thread_1", turnId: "turn_1", itemId: "patch_1" },
          }),
        ).resolves.toEqual({ decision: "decline" });
        await expect(
          onServerRequest({
            id: "approval_3",
            method: "item/permissions/requestApproval",
            params: {
              threadId: "thread_1",
              turnId: "turn_1",
              itemId: "permissions_1",
              permissions: [{ type: "network" }],
            },
          }),
        ).resolves.toEqual({ permissions: [] });
        return {
          sessionId: "thread_existing",
          status: "success" as const,
          result: "Done.",
          error: null,
          usage: null,
          goal: null,
        };
      },
    );

    await runGoatCodexChatTurn({
      turn: codexTurn(),
      session: codexSession(),
      env: env(),
    });
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

  it("persists a staged ChatGPT auth cache after an ordinary turn failure", async () => {
    const auth = {
      kind: "chatgpt" as const,
      authJson: { tokens: { refresh_token: "refresh" } },
      credentialLastRotatedAt: new Date("2026-08-01T12:00:00.000Z"),
      brokered: false as const,
    };
    codexAuthMocks.loadGoatCodexCliAuth.mockResolvedValueOnce(auth);
    appServerMocks.runCodexAppServerTurn.mockRejectedValueOnce(
      new Error("Codex failed after rotating its auth cache."),
    );

    await expect(
      runGoatCodexChatTurn({
        turn: codexTurn(),
        session: codexSession(),
        env: env(),
      }),
    ).resolves.toBe("settled");

    expect(codexAuthMocks.persistRefreshedGoatCodexAuth).toHaveBeenCalledOnce();
    expect(codexAuthMocks.persistRefreshedGoatCodexAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        auth,
        codexHome: CODEX_CHAT_HOME,
      }),
    );
  });

  it("stages workspace repository config and includes only its prompt fragment", async () => {
    let resolveBootstrap:
      | ((bootstrap: { configs: []; promptFragment: string; secretValues: string[] }) => void)
      | undefined;
    repoBootstrapMocks.loadGoatRepositoryBootstrap.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBootstrap = resolve;
        }),
    );
    dbMocks.selectRows.push([]);
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockImplementationOnce(async () => {
      expect(resolveBootstrap).toBeTypeOf("function");
      resolveBootstrap?.({
        configs: [],
        promptFragment:
          '<repository_bootstrap>\nWhen working on "opencompany/app": its environment file is staged at "/opt/oc/repos/123/.env".\nAfter cloning a repository, read and follow its root AGENTS.md and CLAUDE.md files when present, before running setup or development commands.\n</repository_bootstrap>',
        secretValues: ["never-project-this-secret"],
      });
      return sandbox;
    });

    await runGoatCodexChatTurn({
      turn: codexTurn(),
      session: { ...codexSession(), workspaceId: "goat_ws_1" },
      env: env(),
    });

    expect(repoBootstrapMocks.loadGoatRepositoryBootstrap).toHaveBeenCalledWith(
      "goat_ws_1",
      "user_1",
    );
    expect(repoBootstrapMocks.stageGoatRepositoryBootstrap).toHaveBeenCalledWith({
      sandbox,
      bootstrap: expect.objectContaining({
        secretValues: ["never-project-this-secret"],
      }),
    });
    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("/opt/oc/repos/123/.env"),
      }),
    );
    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("read and follow its root AGENTS.md and CLAUDE.md files"),
      }),
    );
  });

  it("propagates repository bootstrap load failures so the worker can retry the turn", async () => {
    const loadError = new Error("database unavailable");
    repoBootstrapMocks.loadGoatRepositoryBootstrap.mockRejectedValueOnce(loadError);
    dbMocks.selectRows.push([]);

    await expect(
      runGoatCodexChatTurn({
        turn: codexTurn(),
        session: { ...codexSession(), workspaceId: "goat_ws_1" },
        env: env(),
      }),
    ).rejects.toBe(loadError);

    expect(sandboxMocks.createOrConnectSandbox).toHaveBeenCalled();
    expect(appServerMocks.runCodexAppServerTurn).not.toHaveBeenCalled();
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

  it("materializes and invokes only the current workflow step skills for durable tasks", async () => {
    dbMocks.execute.mockResolvedValue({ rows: [{ id: "updated", outcome: "updated" }] });
    dbMocks.selectRows.push(
      [{ interruptRequestedAt: null, leaseId: "lease_1", leaseOwner: "runner_1" }],
      [],
      [],
      [
        {
          skillId: "coding-work",
          activatedMessageId: "goat_msg_user_previous",
          name: "Coding work",
          description: "An older interactive snapshot.",
          instructions: "Use the older interactive instructions.",
          activatedAt: new Date("2026-07-10T11:00:00Z"),
        },
        {
          skillId: "chat-skill",
          activatedMessageId: "goat_msg_user_1",
          name: "Chat skill",
          description: "A skill activated on this message.",
          instructions: "Apply the current chat instructions.",
          activatedAt: new Date("2026-07-10T12:00:00Z"),
        },
      ],
    );
    appServerMocks.runCodexAppServerTurn.mockResolvedValueOnce({
      sessionId: "thread_existing",
      status: "failed",
      result: "",
      error: "Expected test stop.",
      usage: null,
      goal: null,
    });
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);
    const harnessSpec = workflowTaskHarnessSpec();

    await runGoatCodexChatTurn({
      turn: codexTurn(),
      session: codexSession(),
      taskContext: {
        task: workflowTask(harnessSpec),
        harnessSpec,
      },
      env: env(),
    });

    expect(sandbox.files.write).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          path: "/home/user/opencompany-goat/codex-chat/.agents/skills/coding-work/SKILL.md",
          data: expect.stringContaining("Use the immutable workflow instructions."),
        },
        {
          path: "/home/user/opencompany-goat/codex-chat/.agents/skills/chat-skill/SKILL.md",
          data: expect.stringContaining("Apply the current chat instructions."),
        },
      ]),
    );
    expect(sandbox.files.write).not.toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/home/user/opencompany-goat/codex-chat/.agents/skills/research-work/SKILL.md",
        }),
      ]),
    );
    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        skills: [
          {
            name: "chat-skill",
            path: "/home/user/opencompany-goat/codex-chat/.agents/skills/chat-skill/SKILL.md",
          },
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
    const statements = dbMocks.execute.mock.calls.map(([query]) => sqlText(query));
    expect(statements).toContainEqual(
      expect.stringContaining("SET engine_recovery_required = true"),
    );
    expect(statements).toContainEqual(expect.stringContaining("SET sandbox_timeout_armed_at"));
    expect(sandboxMocks.armSandboxIdleTimeout).toHaveBeenCalledWith(sandbox, 300_000);
  });

  it("caps finished durable task sandbox parking at 5 minutes", async () => {
    dbMocks.execute.mockResolvedValue({ rows: [{ id: "updated", outcome: "updated" }] });
    dbMocks.selectRows.push(
      [{ interruptRequestedAt: null, leaseId: "lease_1", leaseOwner: "runner_1" }],
      [{ interruptRequestedAt: null, leaseId: "lease_1", leaseOwner: "runner_1" }],
      [],
      [],
    );
    appServerMocks.runCodexAppServerTurn.mockResolvedValueOnce({
      sessionId: "thread_existing",
      status: "failed",
      result: "",
      error: "Expected test stop.",
      usage: null,
      goal: null,
    });
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);
    const harnessSpec = workflowTaskHarnessSpec();

    await runGoatCodexChatTurn({
      turn: codexTurn(),
      session: codexSession(),
      taskContext: {
        task: workflowTask(harnessSpec),
        harnessSpec,
      },
      env: env({ goatCodexChatIdleTimeoutMs: 30 * 60 * 1000 }),
    });

    expect(sandboxMocks.createOrConnectSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ idleTimeoutMs: 30 * 60 * 1000 }),
    );
    expect(sandboxMocks.armSandboxIdleTimeout).toHaveBeenCalledWith(sandbox, 300_000);
  });

  it("preserves the turn when sandbox acquisition fails transiently", async () => {
    dbMocks.selectRows.push([]);
    const capacity = new Error("500: Failed to place sandbox");
    capacity.name = "SandboxError";
    sandboxMocks.createOrConnectSandbox.mockRejectedValueOnce(capacity);
    sandboxMocks.isRetryableSandboxAcquisitionError.mockReturnValueOnce(true);

    await expect(
      runGoatCodexChatTurn({
        turn: codexTurn(),
        session: codexSession(),
        env: env(),
      }),
    ).rejects.toBeInstanceOf(GoatCodexChatRetryableInfrastructureError);

    expect(eventMocks.createGoatCodexChatProjector).not.toHaveBeenCalled();
    expect(appServerMocks.runCodexAppServerTurn).not.toHaveBeenCalled();
  });

  it("keeps permanent sandbox acquisition failures terminal", async () => {
    dbMocks.selectRows.push([]);
    const authentication = new Error("Unauthorized");
    authentication.name = "AuthenticationError";
    sandboxMocks.createOrConnectSandbox.mockRejectedValueOnce(authentication);

    await expect(
      runGoatCodexChatTurn({
        turn: codexTurn(),
        session: codexSession(),
        env: env(),
      }),
    ).resolves.toBe("settled");

    const projector = eventMocks.createGoatCodexChatProjector.mock.results[0]?.value;
    expect(projector.fail).toHaveBeenCalledWith(
      "Codex sandbox could not be started: Unauthorized. Send your message again to retry.",
    );
  });

  it("persists the engine turn baseline at the start boundary", async () => {
    dbMocks.selectRows.push([]);

    await runGoatCodexChatTurn({
      turn: codexTurn(),
      session: codexSession(),
      env: env(),
    });

    const recoveryBoundaryIndex = dbMocks.execute.mock.calls.findIndex(([query]) =>
      sqlText(query).includes("engine_recovery_required = true"),
    );
    expect(recoveryBoundaryIndex).toBeGreaterThanOrEqual(0);
    expect(sqlText(dbMocks.execute.mock.calls[recoveryBoundaryIndex]?.[0])).toContain(
      "engine_turn_baseline_ids",
    );
  });

  it("settles a deferred turn interrupted before sandbox acquisition", async () => {
    dbMocks.selectRows.push([]);

    await expect(
      runGoatCodexChatTurn({
        turn: { ...codexTurn(), interruptRequestedAt: new Date("2026-07-10T09:01:00.000Z") },
        session: codexSession(),
        env: env(),
        recovery: { reason: "lease_reclaimed" },
      }),
    ).resolves.toBe("settled");

    const projector = eventMocks.createGoatCodexChatProjector.mock.results[0]?.value;
    expect(projector.interrupted).toHaveBeenCalledOnce();
    expect(codexAuthMocks.loadGoatCodexCliAuth).not.toHaveBeenCalled();
    expect(sandboxMocks.createOrConnectSandbox).not.toHaveBeenCalled();
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
    expect(sandboxMocks.armSandboxActiveTimeoutById).toHaveBeenCalledWith("sbx_existing");
    expect(sandboxMocks.armSandboxIdleTimeout).not.toHaveBeenCalled();
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
    expect(sandboxMocks.armSandboxActiveTimeoutById).toHaveBeenCalledWith("sbx_existing");
    expect(sandboxMocks.armSandboxIdleTimeout).not.toHaveBeenCalled();
  });

  it("does not park a sandbox after shutdown already released the lease", async () => {
    dbMocks.selectRows.push([]);
    dbMocks.execute.mockImplementation(async (query) => ({
      rows: sqlText(query).includes("SELECT 1") ? [] : [{ id: "updated" }],
    }));
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

    expect(sandboxMocks.armSandboxActiveTimeoutById).not.toHaveBeenCalled();
    expect(sandboxMocks.armSandboxIdleTimeout).not.toHaveBeenCalled();
  });

  it("does not shorten the active timeout while a handed-off turn still owns its lease", async () => {
    dbMocks.selectRows.push([]);
    dbMocks.execute.mockImplementation(async () => ({ rows: [{ id: "owned" }] }));
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

    expect(sandboxMocks.armSandboxActiveTimeoutById).toHaveBeenCalledWith("sbx_existing");
    expect(sandboxMocks.armSandboxIdleTimeout).not.toHaveBeenCalled();
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

  it("rearms recovery only after persisting a replacement engine turn", async () => {
    dbMocks.selectRows.push([]);
    appServerMocks.runCodexAppServerTurn.mockImplementationOnce(
      async (input: {
        onRecoveryStart?: () => Promise<void>;
        onEngineTurnId?: (turnId: string) => Promise<void>;
      }) => {
        await input.onRecoveryStart?.();
        await input.onEngineTurnId?.("turn_recovered");
        return {
          sessionId: "thread_existing",
          status: "success",
          result: "Done.",
          error: null,
          usage: null,
          goal: null,
        };
      },
    );

    await runGoatCodexChatTurn({
      turn: {
        ...codexTurn(),
        attempts: 2,
        codexTurnId: "turn_missing",
        recoveryAttempts: 0,
      },
      session: codexSession(),
      env: env(),
      recovery: { reason: "lease_reclaimed" },
    });

    const statements = dbMocks.execute.mock.calls.map(([query]) => sqlText(query));
    const recoveryClaimIndex = statements.findIndex((statement) =>
      statement.includes("recovery_attempts = turn.recovery_attempts + 1"),
    );
    const replacementPersistIndex = statements.findIndex(
      (statement) =>
        statement.includes("codex_turn_id") &&
        statement.includes("turn.codex_turn_id IS DISTINCT FROM") &&
        statement.includes("THEN 0"),
    );

    expect(recoveryClaimIndex).toBeGreaterThanOrEqual(0);
    expect(replacementPersistIndex).toBeGreaterThan(recoveryClaimIndex);
  });

  it("keeps recovery consumed when no replacement engine turn is persisted", async () => {
    dbMocks.selectRows.push([]);
    appServerMocks.runCodexAppServerTurn.mockImplementationOnce(
      async (input: { onRecoveryStart?: () => Promise<void> }) => {
        await input.onRecoveryStart?.();
        throw new Error("turn/start failed");
      },
    );

    await runGoatCodexChatTurn({
      turn: {
        ...codexTurn(),
        attempts: 2,
        codexTurnId: "turn_missing",
        recoveryAttempts: 0,
      },
      session: codexSession(),
      env: env(),
      recovery: { reason: "lease_reclaimed" },
    });

    const statements = dbMocks.execute.mock.calls.map(([query]) => sqlText(query));
    expect(
      statements.filter((statement) =>
        statement.includes("recovery_attempts = turn.recovery_attempts + 1"),
      ),
    ).toHaveLength(1);
    expect(
      statements.some(
        (statement) =>
          statement.includes("codex_turn_id") &&
          statement.includes("turn.codex_turn_id IS DISTINCT FROM"),
      ),
    ).toBe(false);
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

  it("registers read-only action tools for v2 workspace-pinned sessions", async () => {
    await runGoatCodexChatTurn({
      turn: codexTurn(),
      session: {
        ...codexSession(),
        workspaceId: "workspace_1",
        hostToolContractVersion: "goat-codex-host-tools.v2",
      },
      env: env({ goatAppUrl: "https://goat.example.com" }),
    });

    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        dynamicTools: [
          expect.objectContaining({ spec: expect.objectContaining({ name: "publish_artifact" }) }),
          expect.objectContaining({ spec: expect.objectContaining({ name: "list_actions" }) }),
          expect.objectContaining({ spec: expect.objectContaining({ name: "use_action" }) }),
        ],
        task: expect.stringContaining("Read-only actions are available"),
      }),
    );
  });

  it("registers Brain capture for v3 Brain-pinned sessions", async () => {
    await runGoatCodexChatTurn({
      turn: codexTurn(),
      session: {
        ...codexSession(),
        brainRef: "brain_1",
        workspaceId: "workspace_1",
        hostToolContractVersion: "goat-codex-host-tools.v3",
      },
      env: env({ goatAppUrl: "https://goat.example.com" }),
    });

    expect(appServerMocks.runCodexAppServerTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        dynamicTools: [
          expect.objectContaining({ spec: expect.objectContaining({ name: "publish_artifact" }) }),
          expect.objectContaining({ spec: expect.objectContaining({ name: "goat_brain" }) }),
          expect.objectContaining({ spec: expect.objectContaining({ name: "save_to_brain" }) }),
          expect.objectContaining({ spec: expect.objectContaining({ name: "list_actions" }) }),
          expect.objectContaining({ spec: expect.objectContaining({ name: "use_action" }) }),
        ],
        task: expect.stringContaining(
          "A save_to_brain tool is available for the Brain pinned to this chat.",
        ),
      }),
    );
  });
});

describe("claimCodexChatRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.execute.mockReset().mockResolvedValue({ rows: [{ id: "goat_codex_turn_1" }] });
  });

  it("caps recovery at a single attempt by default", async () => {
    await claimCodexChatRecovery({
      turn: codexTurn(),
      leaseId: "lease_1",
      leaseOwner: "runner_1",
    });
    const query = dbMocks.execute.mock.calls[0]?.[0];
    expect(sqlText(query)).toContain("recovery_attempts <");
    expect(sqlNumbers(query)).toContain(1);
  });

  it("allows a higher ceiling for idempotent engines (Claude Code)", async () => {
    await claimCodexChatRecovery({
      turn: codexTurn(),
      leaseId: "lease_1",
      leaseOwner: "runner_1",
      maxRecoveryAttempts: 10,
    });
    const query = dbMocks.execute.mock.calls[0]?.[0];
    expect(sqlText(query)).toContain("recovery_attempts <");
    expect(sqlNumbers(query)).toContain(10);
  });

  it("throws the default Codex message once the ceiling is reached", async () => {
    dbMocks.execute.mockResolvedValue({ rows: [] });
    await expect(
      claimCodexChatRecovery({ turn: codexTurn(), leaseId: "lease_1", leaseOwner: "runner_1" }),
    ).rejects.toThrow("could not safely resume this turn");
  });

  it("throws the provided message once a higher ceiling is exhausted", async () => {
    dbMocks.execute.mockResolvedValue({ rows: [] });
    await expect(
      claimCodexChatRecovery({
        turn: codexTurn(),
        leaseId: "lease_1",
        leaseOwner: "runner_1",
        maxRecoveryAttempts: 10,
        exhaustedMessage: "too many runner restarts",
      }),
    ).rejects.toThrow("too many runner restarts");
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
    leftJoin: () => builder,
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

// Embedded numeric `${value}` interpolations land in queryChunks as raw Number chunks that
// sqlText intentionally skips; expose them so tests can assert on bound integer values.
function sqlNumbers(query: unknown): number[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.filter((chunk): chunk is number => typeof chunk === "number");
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
    engine: "codex",
    model: "gpt-5.5",
    brainRef: null,
    workspaceId: null,
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
    engineRecoveryRequired: false,
    engineTurnBaselineIds: null,
    eventSequence: 0,
    leaseId: "lease_1",
    leaseOwner: "runner_1",
    leaseExpiresAt: new Date("2026-07-10T12:05:00Z"),
    runAfter: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  } as const;
}

function workflowTaskHarnessSpec(): GoatWorkflowHarnessSpec {
  return {
    schemaVersion: "goat.harness.v1",
    engine: "codex",
    model: "openai/gpt-5.5",
    systemPrompt: "Implement and verify the change.",
    systemBlocks: ["Implement and verify the change."],
    initialUserMessage: "Ship the requested change.",
    tools: [],
    skills: [],
    maxModelSteps: 16,
    resultMode: "assistant_final",
    workflow: {
      id: "workflow_1",
      workspaceId: "workspace_1",
      skillIds: ["research-work", "coding-work"],
      currentStepIndex: 1,
      completedStepCount: 1,
      steps: [
        {
          index: 0,
          title: "Research",
          engine: "opencompany",
          model: "moonshotai/kimi-k2.6",
          systemPrompt: "Research the change.",
          systemBlocks: ["Research the change."],
          skillIds: ["research-work"],
        },
        {
          index: 1,
          title: "Implement",
          engine: "codex",
          model: "openai/gpt-5.5",
          systemPrompt: "Implement and verify the change.",
          systemBlocks: ["Implement and verify the change."],
          skillIds: ["coding-work"],
        },
      ],
      skillSnapshots: [
        {
          id: "research-work",
          name: "Research work",
          description: "How to research.",
          instructions: "Use the research instructions.",
        },
        {
          id: "coding-work",
          name: "Coding work",
          description: "How to implement.",
          instructions: "Use the immutable workflow instructions.",
        },
      ],
    },
  };
}

function workflowTask(harnessSpec: GoatWorkflowHarnessSpec): GoatTask {
  const now = new Date("2026-07-10T12:00:00Z");
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Ship workflow",
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    prompt: "Ship the requested change.",
    model: harnessSpec.model,
    sessionId: "goat_chat_1",
    scheduleId: null,
    scheduledFor: null,
    status: "running",
    stage: "running",
    result: null,
    error: null,
    workflowId: "workflow_1",
    workflowBrainRef: null,
    reportedOutcome: null,
    outcomeComment: null,
    harnessSpec,
    debugTrace: {},
    codexEngineSessionId: null,
    sandboxId: null,
    attempts: 1,
    nextRunAt: now,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    internalToken: "internal",
    streamTokenSecret: "stream",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: "codex_api_secret",
    exaApiKey: "exa",
    goatBrowserEnabled: false,
    codexE2bTemplate: undefined,
    codexTimeoutMs: 1_200_000,
    codexModel: "gpt-5.5",
    goatCodexChatIdleTimeoutMs: 300_000,
    jobLeaseTtlMs: 300_000,
    goatTaskWorkerEnabled: false,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner_1",
    ...overrides,
  };
}
