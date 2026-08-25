import {
  ACTION_HOST_TOOL_CONTRACT_VERSION,
  CODEX_COMMAND_TOOL_PART_TYPE,
  type CodexUiMessagePart,
  verifyExternalEngineGatewayTicket,
} from "@opencompany/agent-runtime";
import type { CodexChatSession, CodexChatTurn } from "@opencompany/db/product-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpHarnessTurnInput } from "./acp-harness";
import {
  CodexChatInterruptedError,
  claimCodexChatRecovery,
  createTurnAbortCheck,
  elicitationContent,
  elicitationUserInputParams,
  materializeCodingChatHistory,
  runCodexChatTurn,
  summarizeCodexChatRecoveryProgress,
} from "./codex-chat";
import { CodexChatHandoffError, CodexChatRetryableInfrastructureError } from "./codex-chat-errors";
import type { RunnerEnv } from "./env";

const acpMocks = vi.hoisted(() => ({ runTurn: vi.fn() }));
const attachmentMocks = vi.hoisted(() => ({ downloadBlobBytes: vi.fn() }));
const authMocks = vi.hoisted(() => ({
  loadCodexCliAuth: vi.fn(),
  persistRefreshedCodexAuth: vi.fn(),
}));
const cliMocks = vi.hoisted(() => ({
  buildCodexAcpCommandEnv: vi.fn(),
  ensureCodexAcpAdapterInstalled: vi.fn(),
  killLeftoverCodexTurnProcesses: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  execute: vi.fn(),
}));
const skillBundleMocks = vi.hoisted(() => ({ loadImmutableSkillBundles: vi.fn() }));
const pluginRuntimeMocks = vi.hoisted(() => ({
  loadChatSessionPluginRuntime: vi.fn(),
  loadEnabledPluginSkillBundleIds: vi.fn(),
}));
const managedPluginMocks = vi.hoisted(() => ({
  materializePluginPackagesForSession: vi.fn(),
}));
const pluginDataMocks = vi.hoisted(() => ({
  preparePluginDataRuntime: vi.fn(),
  checkpoint: vi.fn(),
  release: vi.fn(),
  assertHealthy: vi.fn(),
}));
const pluginMcpMocks = vi.hoisted(() => ({
  materializeTrustedPluginMcpLaunchers: vi.fn(),
  stopPluginMcpProcesses: vi.fn(),
}));
const eventMocks = vi.hoisted(() => ({
  createExternalEngineProjector: vi.fn(),
  loadCodexChatAssistantMessageParts: vi.fn(),
}));
const historyMocks = vi.hoisted(() => ({ loadCodingChatHistory: vi.fn() }));
const repoMocks = vi.hoisted(() => ({
  loadRepositoryBootstrap: vi.fn(),
  stageRepositoryBootstrap: vi.fn(),
}));
const sandboxMocks = vi.hoisted(() => ({
  armSandboxActiveTimeoutById: vi.fn(),
  armSandboxIdleTimeout: vi.fn(),
  createOrConnectSandbox: vi.fn(),
  isRetryableCommandStreamError: vi.fn(),
  isRetryableSandboxAcquisitionError: vi.fn(),
  writeSandboxTextFiles: vi.fn(),
}));
const skillMocks = vi.hoisted(() => ({ materializeCodexSkillSnapshotsForSession: vi.fn() }));

vi.mock("./acp-harness", () => ({
  AcpHarness: class AcpHarness {
    async runTurn(input: AcpHarnessTurnInput) {
      try {
        return await acpMocks.runTurn(input);
      } finally {
        await input.onEngineStopped?.();
      }
    }
  },
}));

vi.mock("./attachment-hydration", () => ({
  downloadBlobBytes: attachmentMocks.downloadBlobBytes,
}));

vi.mock("./codex", () => ({
  loadCodexCliAuth: authMocks.loadCodexCliAuth,
  persistRefreshedCodexAuth: authMocks.persistRefreshedCodexAuth,
}));

vi.mock("./codex-cli", () => ({
  buildCodexAcpCommand: () => "exec codex-acp",
  buildCodexAcpCommandEnv: cliMocks.buildCodexAcpCommandEnv,
  ensureCodexAcpAdapterInstalled: cliMocks.ensureCodexAcpAdapterInstalled,
  killLeftoverCodexTurnProcesses: cliMocks.killLeftoverCodexTurnProcesses,
}));

vi.mock("./coding-agent-shared", () => ({
  buildGitHubCommandEnv: () => ({}),
  createKnownSecretRedactor: () => (value: string) => value,
  gitAuthHeader: (token: string) => `Authorization: Basic ${token}`,
}));

vi.mock("./coding-chat-history", async (importOriginal) => {
  const original = await importOriginal<typeof import("./coding-chat-history")>();
  return { ...original, loadCodingChatHistory: historyMocks.loadCodingChatHistory };
});

vi.mock("./codex-chat-events", () => ({
  createExternalEngineProjector: eventMocks.createExternalEngineProjector,
  loadCodexChatAssistantMessageParts: eventMocks.loadCodexChatAssistantMessageParts,
}));

vi.mock("./codex-managed-skills", () => ({
  materializeCodexSkillSnapshotsForSession: skillMocks.materializeCodexSkillSnapshotsForSession,
}));

vi.mock("./db", () => ({
  getDb: () => queryBuilder(dbMocks.selectRows, dbMocks.execute),
}));

vi.mock("@opencompany/db/skill-bundle-repository", () => ({
  loadImmutableSkillBundles: skillBundleMocks.loadImmutableSkillBundles,
}));

vi.mock("@opencompany/db/plugin-runtime-repository", () => ({
  loadChatSessionPluginRuntime: pluginRuntimeMocks.loadChatSessionPluginRuntime,
  loadEnabledPluginSkillBundleIds: pluginRuntimeMocks.loadEnabledPluginSkillBundleIds,
}));

vi.mock("./managed-plugins", () => ({
  materializePluginPackagesForSession: managedPluginMocks.materializePluginPackagesForSession,
}));

vi.mock("./plugin-data-runtime", () => ({
  preparePluginDataRuntime: pluginDataMocks.preparePluginDataRuntime,
}));

vi.mock("./plugin-mcp-launcher", () => ({
  materializeTrustedPluginMcpLaunchers: pluginMcpMocks.materializeTrustedPluginMcpLaunchers,
  stopPluginMcpProcesses: pluginMcpMocks.stopPluginMcpProcesses,
}));

vi.mock("./github", () => ({ getGitHubWorkInstallationToken: vi.fn() }));

vi.mock("./infisical-sandbox-auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("./infisical-sandbox-auth")>();
  return {
    ...original,
    reconcileInfisicalSandboxAuth: vi.fn(async () => ({
      available: false,
      promptFragment: "",
      redactionValues: [],
    })),
  };
});

vi.mock("./repo-bootstrap", () => ({
  loadRepositoryBootstrap: repoMocks.loadRepositoryBootstrap,
  stageRepositoryBootstrap: repoMocks.stageRepositoryBootstrap,
}));

vi.mock("./sandbox", () => ({
  managedSandboxMetadata: (input: {
    ownerKind: string;
    ownerId: string;
    metadata?: Record<string, string>;
  }) => ({
    ...input.metadata,
    opencompany_managed: "true",
    opencompany_owner_kind: input.ownerKind,
    opencompany_owner_id: input.ownerId,
  }),
  armSandboxActiveTimeoutById: sandboxMocks.armSandboxActiveTimeoutById,
  armSandboxIdleTimeout: sandboxMocks.armSandboxIdleTimeout,
  createOrConnectSandbox: sandboxMocks.createOrConnectSandbox,
  isRetryableCommandStreamError: sandboxMocks.isRetryableCommandStreamError,
  isRetryableSandboxAcquisitionError: sandboxMocks.isRetryableSandboxAcquisitionError,
  writeSandboxTextFiles: sandboxMocks.writeSandboxTextFiles,
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
      shouldAbort: () => new CodexChatHandoffError(),
    });

    await expect(checkAbort()).rejects.toBeInstanceOf(CodexChatInterruptedError);
  });

  it("still hands off when the durable turn has no interrupt request", async () => {
    dbMocks.selectRows.push([
      { interruptRequestedAt: null, leaseId: "lease_1", leaseOwner: "runner_1" },
    ]);
    const checkAbort = createTurnAbortCheck({
      turnId: "turn_1",
      leaseId: "lease_1",
      leaseOwner: "runner_1",
      shouldAbort: () => new CodexChatHandoffError(),
    });

    await expect(checkAbort()).rejects.toBeInstanceOf(CodexChatHandoffError);
  });
});

describe("materializeCodingChatHistory", () => {
  it("keeps recovery usable when an old attachment blob is unavailable", async () => {
    attachmentMocks.downloadBlobBytes.mockRejectedValueOnce(new Error("Blob not found"));
    const result = await materializeCodingChatHistory({
      sandbox: fakeSandbox("sbx_existing") as never,
      turnId: "turn_2",
      history: {
        messages: [],
        materializableAttachments: [imageAttachment("attachment_missing")],
        omittedTurnCount: 0,
        omittedAttachmentCount: 0,
      },
      blobToken: "blob-token",
    });

    expect(result.materialization.pathsByAttachmentId).toEqual(new Map());
    expect(result.materialization.unavailableAttachmentIds).toEqual(
      new Set(["attachment_missing"]),
    );
    expect(result.imagePromptBlocks).toEqual([]);
  });
});

describe("ACP elicitation translation", () => {
  const codexOtherSchema = {
    mode: "form",
    message: "Choose a branch",
    requestedSchema: {
      type: "object",
      properties: {
        branch: {
          type: "string",
          title: "Branch",
          description: "Which branch should be used?",
          oneOf: [
            { const: "main", title: "Main" },
            { const: "feature", title: "Feature" },
          ],
          _meta: { codex: { isOther: true, isSecret: false } },
        },
        branch_other: {
          type: "string",
          title: "Other",
          _meta: {
            codex: { questionId: "branch", isOtherAnswer: true, isSecret: false },
          },
        },
      },
      required: [],
    },
  };

  it("folds Codex's hidden Other field into one logical question", () => {
    expect(
      elicitationUserInputParams({
        params: codexOtherSchema,
        engineSessionId: "session_1",
        turnId: "turn_1",
      }),
    ).toMatchObject({
      threadId: "session_1",
      turnId: "turn_1",
      questions: [
        {
          id: "branch",
          header: "Branch",
          question: "Which branch should be used?",
          options: [
            { label: "Main", description: "" },
            { label: "Feature", description: "" },
          ],
          isOther: true,
          isSecret: false,
        },
      ],
    });
  });

  it("returns Codex option and custom answers under the schema's correct fields", () => {
    expect(
      elicitationContent(codexOtherSchema, {
        answers: { branch: { answers: ["Feature"] } },
      }),
    ).toEqual({ branch: "feature" });
    expect(
      elicitationContent(codexOtherSchema, {
        answers: { branch: { answers: ["release/next"] } },
      }),
    ).toEqual({ branch_other: "release/next" });
  });

  it("coerces standard MCP boolean, integer, and enum form answers", () => {
    const params = {
      message: "Configure the event",
      requestedSchema: {
        type: "object",
        properties: {
          newsletter: { type: "boolean", title: "Newsletter" },
          duration: { type: "integer", minimum: 15, maximum: 480 },
          visibility: {
            type: "string",
            enum: ["private", "public"],
            enumNames: ["Private", "Public"],
          },
        },
        required: ["newsletter", "duration", "visibility"],
      },
    };
    expect(
      elicitationUserInputParams({
        params,
        engineSessionId: "session_1",
        turnId: "turn_1",
      }),
    ).toMatchObject({
      questions: [
        { id: "newsletter", options: [{ label: "Yes" }, { label: "No" }] },
        { id: "duration" },
        { id: "visibility", options: [{ label: "Private" }, { label: "Public" }] },
      ],
    });
    expect(
      elicitationContent(params, {
        answers: {
          newsletter: { answers: ["Yes"] },
          duration: { answers: ["45"] },
          visibility: { answers: ["Public"] },
        },
      }),
    ).toEqual({ newsletter: true, duration: 45, visibility: "public" });
  });

  it("supports one selection from a titled MCP multi-select schema", () => {
    const params = {
      mode: "form",
      message: "Choose tags",
      requestedSchema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            minItems: 1,
            items: {
              anyOf: [
                { const: "urgent", title: "Urgent" },
                { const: "customer", title: "Customer" },
              ],
            },
          },
        },
        required: ["tags"],
      },
    };
    expect(
      elicitationContent(params, {
        answers: { tags: { answers: ["Customer"] } },
      }),
    ).toEqual({ tags: ["customer"] });
  });

  it("declines forms that cannot fit the durable question surface", () => {
    expect(
      elicitationUserInputParams({
        params: {
          mode: "form",
          message: "Too many fields",
          requestedSchema: {
            type: "object",
            properties: {
              one: { type: "string" },
              two: { type: "string" },
              three: { type: "string" },
              four: { type: "string" },
            },
          },
        },
        engineSessionId: "session_1",
        turnId: "turn_1",
      }),
    ).toBeNull();
  });
});

describe("runCodexChatTurn over ACP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectRows.length = 0;
    dbMocks.execute.mockReset().mockResolvedValue({ rows: [{ id: "updated" }] });
    skillBundleMocks.loadImmutableSkillBundles.mockReset().mockResolvedValue([]);
    pluginRuntimeMocks.loadChatSessionPluginRuntime
      .mockReset()
      .mockResolvedValue({ plugins: [], skills: [], mcpPlugins: [] });
    pluginRuntimeMocks.loadEnabledPluginSkillBundleIds.mockReset().mockResolvedValue(new Set());
    managedPluginMocks.materializePluginPackagesForSession.mockReset().mockResolvedValue({
      fingerprint: "plugins",
      count: 0,
    });
    pluginDataMocks.preparePluginDataRuntime.mockReset().mockResolvedValue({
      dataRoots: new Map([["quality-tools", "/plugin-data/quality-tools"]]),
      checkpoint: pluginDataMocks.checkpoint,
      release: pluginDataMocks.release,
      assertHealthy: pluginDataMocks.assertHealthy,
    });
    pluginDataMocks.checkpoint.mockReset().mockResolvedValue(undefined);
    pluginDataMocks.release.mockReset().mockResolvedValue(undefined);
    pluginDataMocks.assertHealthy.mockReset();
    pluginMcpMocks.materializeTrustedPluginMcpLaunchers
      .mockReset()
      .mockImplementation(async (input: { mcpPlugins: unknown[] }) =>
        input.mcpPlugins.length === 0
          ? { servers: [], pluginUsers: [] }
          : {
              servers: [preparedPluginMcpServer()],
              pluginUsers: [{ pluginName: "quality-tools", user: "ocp_test" }],
            },
      );
    pluginMcpMocks.stopPluginMcpProcesses.mockReset().mockResolvedValue(undefined);
    authMocks.loadCodexCliAuth.mockResolvedValue({
      kind: "api",
      baseUrl: "https://api.openai.test/v1",
      apiKeyEnvVar: "CODEX_API_KEY",
      apiKeyValue: "codex_secret",
      brokered: false,
    });
    authMocks.persistRefreshedCodexAuth.mockResolvedValue(undefined);
    cliMocks.buildCodexAcpCommandEnv.mockReturnValue({
      CODEX_HOME: "/home/user/.opencompany-goat/codex-chat-home",
      CODEX_CONFIG: "{}",
      CODEX_API_KEY: "codex_secret",
    });
    cliMocks.ensureCodexAcpAdapterInstalled.mockResolvedValue(undefined);
    cliMocks.killLeftoverCodexTurnProcesses.mockResolvedValue(undefined);
    historyMocks.loadCodingChatHistory.mockResolvedValue(emptyHistory());
    eventMocks.loadCodexChatAssistantMessageParts.mockResolvedValue([]);
    eventMocks.createExternalEngineProjector.mockImplementation(
      (input: { normalizeEvent?: (event: Record<string, unknown>) => unknown }) => ({
        push: vi.fn(async (events: Record<string, unknown>[]) => {
          for (const event of events) input.normalizeEvent?.(event);
        }),
        finalize: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
        interrupted: vi.fn(async () => undefined),
        requestApproval: vi.fn(),
        requestUserInput: vi.fn(),
        resolveApproval: vi.fn(),
        resolveInteraction: vi.fn(),
        cancelPendingInteractions: vi.fn(async () => false),
      }),
    );
    repoMocks.loadRepositoryBootstrap.mockResolvedValue({
      configs: [],
      promptFragment: "",
      secretValues: [],
    });
    repoMocks.stageRepositoryBootstrap.mockResolvedValue(undefined);
    sandboxMocks.armSandboxActiveTimeoutById.mockResolvedValue(true);
    sandboxMocks.armSandboxIdleTimeout.mockResolvedValue(true);
    sandboxMocks.createOrConnectSandbox.mockResolvedValue(fakeSandbox("sbx_existing"));
    sandboxMocks.isRetryableCommandStreamError.mockReturnValue(false);
    sandboxMocks.isRetryableSandboxAcquisitionError.mockReturnValue(false);
    sandboxMocks.writeSandboxTextFiles.mockResolvedValue(undefined);
    skillMocks.materializeCodexSkillSnapshotsForSession.mockResolvedValue(undefined);
    attachmentMocks.downloadBlobBytes.mockResolvedValue(Buffer.from("image bytes"));
    acpMocks.runTurn.mockImplementation(completeAcpTurn);
  });

  it("uses the Codex adapter with model, reasoning, plan, goal, and the shared MCP", async () => {
    await expect(
      runCodexChatTurn({
        turn: codexTurn({
          settings: {
            reasoningEffort: "high",
            planModeReasoningEffort: "xhigh",
            goalMode: { objective: "Finish issue 1324", tokenBudget: 50_000 },
          },
        }),
        session: codexSession({
          workspaceId: "workspace_1",
          brainRef: "brain_1",
          hostToolContractVersion: ACTION_HOST_TOOL_CONTRACT_VERSION,
        }),
        canonicalAttemptId: "attempt_1",
        env: env({ runnerPublicUrl: "https://runner.example.com" }),
      }),
    ).resolves.toBe("settled");

    expect(cliMocks.ensureCodexAcpAdapterInstalled).toHaveBeenCalledOnce();
    expect(acpMocks.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: expect.objectContaining({ id: "codex" }),
        existingSessionId: "thread_existing",
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
        permissionMode: "bypassPermissions",
        collaborationMode: "plan",
        goal: { objective: "Finish issue 1324", tokenBudget: 50_000 },
      }),
    );
    const harnessInput = acpMocks.runTurn.mock.calls[0]?.[0] as AcpHarnessTurnInput;
    expect(harnessInput.task).toContain("list_actions and use_action");
    expect(harnessInput.task).toContain("save_to_brain");
    const [mcpServer] = harnessInput.mcpServers;
    expect(mcpServer).toMatchObject({
      name: "opencompany",
      url: "https://runner.example.com/internal/goat/acp-tools",
    });
    if (!mcpServer || !("headers" in mcpServer)) throw new Error("Expected HTTP MCP server.");
    const ticket = mcpServer?.headers.find(
      (header) => header.name === "x-opencompany-tool-ticket",
    )?.value;
    expect(
      verifyExternalEngineGatewayTicket({ ticket: ticket ?? "", secret: "internal" }),
    ).toMatchObject({
      codexChatSessionId: "goat_codex_chat_1",
      codexChatTurnId: "goat_codex_turn_1",
      attemptId: "attempt_1",
      leaseId: "lease_1",
    });
  });

  it("sends current-turn images as standard ACP prompt blocks", async () => {
    dbMocks.selectRows.push([], [{ attachments: [imageAttachment("image_1")] }], []);

    await runCodexChatTurn({
      turn: codexTurn(),
      session: codexSession(),
      env: env(),
    });

    const harnessInput = acpMocks.runTurn.mock.calls[0]?.[0] as AcpHarnessTurnInput;
    expect(harnessInput.prompt).toContainEqual({
      type: "image",
      data: Buffer.from("image bytes").toString("base64"),
      mimeType: "image/png",
    });
    expect(harnessInput.task).toContain("image_1-screenshot.png");
  });

  it("never exposes MCP for an installed but unapproved Plugin", async () => {
    const { pluginPackage } = approvedPluginRuntime();
    pluginRuntimeMocks.loadChatSessionPluginRuntime.mockResolvedValueOnce({
      plugins: [pluginPackage],
      skills: [],
      mcpPlugins: [],
    });

    await runCodexChatTurn({
      turn: codexTurn(),
      session: codexSession({ workspaceId: "workspace_1" }),
      env: env(),
    });

    expect(pluginDataMocks.preparePluginDataRuntime).not.toHaveBeenCalled();
    expect(pluginMcpMocks.materializeTrustedPluginMcpLaunchers).toHaveBeenCalledWith(
      expect.objectContaining({ mcpPlugins: [], dataRoots: new Map() }),
    );
    expect(acpMocks.runTurn).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: [] }));
  });

  it("passes approved Plugin MCP through ACP and checkpoints only after turn-end quiesce", async () => {
    const { pluginPackage, mcpPlugin } = approvedPluginRuntime();
    pluginRuntimeMocks.loadChatSessionPluginRuntime.mockResolvedValueOnce({
      plugins: [pluginPackage],
      skills: [],
      mcpPlugins: [mcpPlugin],
    });

    await runCodexChatTurn({
      turn: codexTurn(),
      session: codexSession({ workspaceId: "workspace_1" }),
      env: env(),
    });

    expect(pluginDataMocks.preparePluginDataRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace_1", mcpPlugins: [mcpPlugin] }),
    );
    expect(acpMocks.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: [expect.objectContaining({ name: "quality-tools.local", env: [] })],
        onEngineStopped: expect.any(Function),
      }),
    );
    expect(pluginMcpMocks.stopPluginMcpProcesses).toHaveBeenCalledWith(expect.anything(), [
      { pluginName: "quality-tools", user: "ocp_test" },
    ]);
    expect(pluginDataMocks.checkpoint).toHaveBeenCalledWith({ releaseLease: true });
    expect(pluginMcpMocks.stopPluginMcpProcesses.mock.invocationCallOrder[0]).toBeLessThan(
      pluginDataMocks.checkpoint.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    ["disabled", { plugins: [], skills: [], mcpPlugins: [] }],
    [
      "approval revoked",
      { plugins: [approvedPluginRuntime().pluginPackage], skills: [], mcpPlugins: [] },
    ],
  ])("removes Plugin MCP on the next turn when it is %s", async (_state, nextRuntime) => {
    const { pluginPackage, mcpPlugin } = approvedPluginRuntime();
    pluginRuntimeMocks.loadChatSessionPluginRuntime
      .mockResolvedValueOnce({ plugins: [pluginPackage], skills: [], mcpPlugins: [mcpPlugin] })
      .mockResolvedValueOnce(nextRuntime);

    await runCodexChatTurn({
      turn: codexTurn(),
      session: codexSession({ workspaceId: "workspace_1" }),
      env: env(),
    });
    await runCodexChatTurn({
      turn: codexTurn({ id: "goat_codex_turn_2" }),
      session: codexSession({ workspaceId: "workspace_1" }),
      env: env(),
    });

    const firstInput = acpMocks.runTurn.mock.calls[0]?.[0] as AcpHarnessTurnInput;
    const nextInput = acpMocks.runTurn.mock.calls[1]?.[0] as AcpHarnessTurnInput;
    expect(firstInput.mcpServers).toEqual([
      expect.objectContaining({ name: "quality-tools.local" }),
    ]);
    expect(nextInput.mcpServers).toEqual([]);
  });

  it("reports a Plugin checkpoint failure without retrying the one-shot checkpoint", async () => {
    const { pluginPackage, mcpPlugin } = approvedPluginRuntime();
    pluginRuntimeMocks.loadChatSessionPluginRuntime.mockResolvedValueOnce({
      plugins: [pluginPackage],
      skills: [],
      mcpPlugins: [mcpPlugin],
    });
    pluginDataMocks.checkpoint.mockRejectedValueOnce(new Error("checkpoint storage unavailable"));

    await runCodexChatTurn({
      turn: codexTurn(),
      session: codexSession({ workspaceId: "workspace_1" }),
      env: env(),
    });

    expect(pluginDataMocks.checkpoint).toHaveBeenCalledOnce();
    const projector = eventMocks.createExternalEngineProjector.mock.results.at(-1)?.value;
    expect(projector.fail).toHaveBeenCalledWith(
      expect.stringContaining("Plugin data checkpointing failed: checkpoint storage unavailable"),
      expect.objectContaining({
        failureDiagnostic: expect.stringContaining("checkpoint storage unavailable"),
      }),
    );
  });

  it("bootstraps durable history after ACP invalidates a stored session", async () => {
    dbMocks.selectRows.push(
      [],
      [],
      [],
      [{ interruptRequestedAt: null, leaseId: "lease_1", leaseOwner: "runner_1" }],
    );
    historyMocks.loadCodingChatHistory.mockResolvedValueOnce({
      messages: [
        { role: "user", content: "Inspect the repository.", attachments: [] },
        { role: "assistant", content: "It uses Next.js.", attachments: [] },
      ],
      materializableAttachments: [],
      omittedTurnCount: 0,
      omittedAttachmentCount: 0,
    });
    let resumedTask = "";
    let freshTask = "";
    acpMocks.runTurn.mockImplementationOnce(async (input: AcpHarnessTurnInput) => {
      resumedTask = input.task;
      await input.onExistingSessionInvalidated();
      freshTask = await input.prepareFreshTask();
      await input.onEngineSessionId("thread_fresh");
      await input.onRuntimeEvents(successfulAcpEvents("Recovered."));
      return harnessResult("thread_fresh", false);
    });

    await runCodexChatTurn({
      turn: codexTurn({ prompt: "What did we establish?" }),
      session: codexSession({ codexThreadId: "thread_missing" }),
      env: env(),
    });

    expect(resumedTask).not.toContain("Inspect the repository.");
    expect(freshTask).toMatch(
      /conversation_history_json[\s\S]*Inspect the repository\.[\s\S]*What did we establish\?/u,
    );
    expect(
      dbMocks.execute.mock.calls.some(([query]) => sqlText(query).includes("codex_thread_id =")),
    ).toBe(true);
  });

  it("cancels stale durable interactions before a reclaimed ACP turn", async () => {
    await runCodexChatTurn({
      turn: codexTurn(),
      session: codexSession(),
      recovery: { reason: "lease_reclaimed" },
      env: env(),
    });

    const projector = eventMocks.createExternalEngineProjector.mock.results.at(-1)?.value;
    expect(projector.cancelPendingInteractions).toHaveBeenCalledOnce();
    expect(sqlText(dbMocks.execute.mock.calls[0]?.[0])).toContain("recovery_attempts");
  });

  it("defers a command-stream timeout during recovery preflight with its exact stage", async () => {
    const preflightError = new Error("2: [unknown] The operation timed out.");
    preflightError.name = "SandboxError";
    repoMocks.loadRepositoryBootstrap.mockRejectedValueOnce(preflightError);
    sandboxMocks.isRetryableCommandStreamError.mockImplementation(
      (error) => error === preflightError,
    );

    await expect(
      runCodexChatTurn({
        turn: codexTurn(),
        session: codexSession(),
        recovery: { reason: "lease_reclaimed" },
        env: env(),
      }),
    ).rejects.toMatchObject({
      name: CodexChatRetryableInfrastructureError.name,
      cause: preflightError,
      diagnosticMessage:
        "[load_repository_context] SandboxError: 2: [unknown] The operation timed out.",
    });

    expect(cliMocks.killLeftoverCodexTurnProcesses).toHaveBeenCalledOnce();
    expect(eventMocks.createExternalEngineProjector).not.toHaveBeenCalled();
    expect(acpMocks.runTurn).not.toHaveBeenCalled();
  });

  it("persists the real stage and error when recovery context loading fails", async () => {
    historyMocks.loadCodingChatHistory.mockRejectedValueOnce(
      new Error("history projection failed"),
    );

    await expect(
      runCodexChatTurn({
        turn: codexTurn(),
        session: codexSession(),
        recovery: { reason: "lease_reclaimed" },
        env: env(),
      }),
    ).resolves.toBe("settled");

    const projector = eventMocks.createExternalEngineProjector.mock.results.at(-1)?.value;
    expect(projector.fail).toHaveBeenCalledWith("history projection failed", {
      failureDiagnostic: "[load_repository_context] Error: history projection failed",
    });
    expect(cliMocks.killLeftoverCodexTurnProcesses).toHaveBeenCalledOnce();
    expect(acpMocks.runTurn).not.toHaveBeenCalled();
  });

  it("fences a reused sandbox before starting the turn", async () => {
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);

    await expect(
      runCodexChatTurn({ turn: codexTurn(), session: codexSession(), env: env() }),
    ).resolves.toBe("settled");

    expect(cliMocks.killLeftoverCodexTurnProcesses).toHaveBeenCalledOnce();
    expect(cliMocks.killLeftoverCodexTurnProcesses).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxId: "sbx_existing" }),
    );
    expect(cliMocks.killLeftoverCodexTurnProcesses.mock.invocationCallOrder[0]).toBeLessThan(
      acpMocks.runTurn.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("skips the fence and invalidates the thread when a fresh sandbox replaced the previous one", async () => {
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(fakeSandbox("sbx_fresh"));

    // A replaced sandbox forces the bootstrap path (extra DB reads this fixture does not seed); we
    // only assert the pre-bootstrap behavior: the fence never runs on a fresh sandbox, and the stale
    // thread id is invalidated alongside the new sandbox id.
    await runCodexChatTurn({ turn: codexTurn(), session: codexSession(), env: env() }).catch(
      () => undefined,
    );

    expect(cliMocks.killLeftoverCodexTurnProcesses).not.toHaveBeenCalled();
    expect(
      dbMocks.execute.mock.calls.some(([query]) => {
        const text = sqlText(query);
        return text.includes("sandbox_id =") && text.includes("codex_thread_id = NULL");
      }),
    ).toBe(true);
  });

  it("retries instead of settling when the previous sandbox process cannot be fenced", async () => {
    const fenceError = new Error("Sandbox command stream is unavailable.");
    cliMocks.killLeftoverCodexTurnProcesses.mockRejectedValueOnce(fenceError);

    await expect(
      runCodexChatTurn({ turn: codexTurn(), session: codexSession(), env: env() }),
    ).rejects.toMatchObject({
      name: CodexChatRetryableInfrastructureError.name,
      cause: fenceError,
      diagnosticMessage: "[fence_previous_turn] Error: Sandbox command stream is unavailable.",
    });

    expect(acpMocks.runTurn).not.toHaveBeenCalled();
    expect(eventMocks.createExternalEngineProjector).not.toHaveBeenCalled();
  });

  it("hands a turn off without finalizing when ACP is interrupted by shutdown", async () => {
    const { pluginPackage, mcpPlugin } = approvedPluginRuntime();
    pluginRuntimeMocks.loadChatSessionPluginRuntime.mockResolvedValueOnce({
      plugins: [pluginPackage],
      skills: [],
      mcpPlugins: [mcpPlugin],
    });
    acpMocks.runTurn.mockRejectedValueOnce(new CodexChatHandoffError());

    await expect(
      runCodexChatTurn({
        turn: codexTurn(),
        session: codexSession({ workspaceId: "workspace_1" }),
        env: env(),
      }),
    ).resolves.toBe("handed_off");

    const projector = eventMocks.createExternalEngineProjector.mock.results.at(-1)?.value;
    expect(projector.finalize).not.toHaveBeenCalled();
    expect(projector.fail).not.toHaveBeenCalled();
    expect(pluginMcpMocks.stopPluginMcpProcesses).toHaveBeenCalledOnce();
    expect(pluginDataMocks.checkpoint).not.toHaveBeenCalled();
    expect(pluginDataMocks.release).toHaveBeenCalledOnce();
  });

  it("stages ChatGPT authentication for the ACP adapter", async () => {
    authMocks.loadCodexCliAuth.mockResolvedValueOnce({
      kind: "chatgpt",
      authJson: { tokens: { access_token: "chatgpt-secret" } },
    });
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);

    await runCodexChatTurn({ turn: codexTurn(), session: codexSession(), env: env() });

    expect(sandbox.files.write).toHaveBeenCalledWith(
      "/home/user/.opencompany-goat/codex-chat-home/auth.json",
      JSON.stringify({ tokens: { access_token: "chatgpt-secret" } }),
    );
    expect(cliMocks.buildCodexAcpCommandEnv).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ kind: "chatgpt" }) }),
    );
  });
});

describe("claimCodexChatRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.execute.mockReset().mockResolvedValue({ rows: [{ id: "goat_codex_turn_1" }] });
  });

  it("uses the configured recovery ceiling", async () => {
    await claimCodexChatRecovery({
      turn: codexTurn(),
      leaseId: "lease_1",
      leaseOwner: "runner_1",
      maxRecoveryAttempts: 10,
    });
    expect(sqlText(dbMocks.execute.mock.calls[0]?.[0])).toContain("recovery_attempts <");
    expect(sqlNumbers(dbMocks.execute.mock.calls[0]?.[0])).toContain(10);
  });

  it("throws the provided message once the ceiling is exhausted", async () => {
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
  it("summarizes durable partial output and in-flight commands", () => {
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
    ];

    const summary = summarizeCodexChatRecoveryProgress(parts);
    expect(summary).toContain("Assistant: I inspected the repo.");
    expect(summary).toContain("Command completed, exit 0: bun test");
    expect(summary).toContain("Command started without a persisted result: git push origin branch");
  });
});

async function completeAcpTurn(input: AcpHarnessTurnInput) {
  await input.onEngineSessionId(input.existingSessionId ?? "thread_new");
  await input.onRuntimeEvents(successfulAcpEvents("Done over ACP."));
  return harnessResult(input.existingSessionId ?? "thread_new", Boolean(input.existingSessionId));
}

function successfulAcpEvents(result: string): Record<string, unknown>[] {
  return [
    {
      method: "session/update",
      params: {
        sessionId: "thread_existing",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "message_1",
          content: { type: "text", text: result },
        },
      },
    },
    {
      method: "session/prompt_result",
      params: {
        sessionId: "thread_existing",
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 4 },
      },
    },
  ];
}

function harnessResult(sessionId: string, loadedSession: boolean) {
  return {
    sessionId,
    loadedSession,
    promptResponse: { stopReason: "end_turn" },
    stderrTail: "",
  };
}

function emptyHistory() {
  return {
    messages: [],
    materializableAttachments: [],
    omittedTurnCount: 0,
    omittedAttachmentCount: 0,
  };
}

function approvedPluginRuntime() {
  const pluginPackage = {
    id: "plugin_quality_v1",
    name: "quality-tools",
    files: [
      {
        path: "plugin.json",
        content: new TextEncoder().encode('{"name":"quality-tools"}'),
        executable: false,
        sizeBytes: 24,
      },
    ],
  };
  return {
    pluginPackage,
    mcpPlugin: {
      id: pluginPackage.id,
      name: pluginPackage.name,
      integrity: `sha256:${"a".repeat(64)}`,
      stdioServers: [
        {
          name: "local",
          type: "stdio" as const,
          command: "node",
          args: ["${PLUGIN_ROOT}/server.mjs"],
          env: {},
        },
      ],
    },
  };
}

function preparedPluginMcpServer() {
  return {
    name: "quality-tools.local",
    command: "/usr/bin/sudo",
    args: ["-n", "-u", "ocp_test", "--", "/launcher.py", "/config.json"],
    env: [],
  };
}

function imageAttachment(id: string) {
  return {
    id,
    kind: "image" as const,
    mediaType: "image/png",
    filename: "screenshot.png",
    sizeBytes: 128,
    blobPathname: `goat-chat/user_1/${id}.png`,
    blobUrl: `https://blob.test/goat-chat/user_1/${id}.png`,
  };
}

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

function sqlNumbers(query: unknown): number[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.filter((chunk): chunk is number => typeof chunk === "number");
}

function fakeSandbox(sandboxId: string) {
  return {
    sandboxId,
    commands: { run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) },
    files: {
      write: vi.fn(async () => undefined),
      read: vi.fn(async () => "{}"),
    },
  };
}

function codexSession(overrides: Partial<CodexChatSession> = {}): CodexChatSession {
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
    ...overrides,
  };
}

function codexTurn(overrides: Partial<CodexChatTurn> = {}): CodexChatTurn {
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
    ...overrides,
  };
}

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    internalToken: "internal",
    streamTokenSecret: "stream",
    apiOrigin: "http://localhost:3001",
    apiInternalToken: "api-internal-secret",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: "codex_api_secret",
    exaApiKey: "exa",
    browserEnabled: false,
    codexE2bTemplate: undefined,
    codexTimeoutMs: 1_200_000,
    codexModel: "gpt-5.5",
    codexChatIdleTimeoutMs: 300_000,
    jobLeaseTtlMs: 300_000,
    taskWorkerEnabled: false,
    codexChatSelfHealEnabled: true,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner_1",
    ...overrides,
  };
}
