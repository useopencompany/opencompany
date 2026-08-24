import {
  ACTION_HOST_TOOL_CONTRACT_VERSION,
  verifyClaudeActionGatewayTicket,
} from "@opencompany/agent-runtime";
import type {
  CodexChatSession,
  CodexChatTurn,
  HarnessSpec,
  Task,
} from "@opencompany/db/product-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractAcpScheduleWakeup,
  isClaudeCodeAuthenticationFailure,
  runClaudeCodeChatTurn,
} from "./claude-code-chat";
import { CodexChatRetryableInfrastructureError } from "./codex-chat-errors";
import type { RunnerEnv } from "./env";

const authMocks = vi.hoisted(() => ({
  loadClaudeCodeCredential: vi.fn(),
  markClaudeCodeCredentialNeedsReauth: vi.fn(),
  markClaudeCodeCredentialValidated: vi.fn(),
}));

const chatMocks = vi.hoisted(() => ({
  claimCodexChatRecovery: vi.fn(),
  codexChatTurnLeaseIsHeld: vi.fn(),
  loadCodexChatAttachments: vi.fn(),
  loadCodexChatSessionSkills: vi.fn(),
  loadGitHubAuthForUser: vi.fn(),
  markCodexChatSandboxTimeoutArmed: vi.fn(),
  materializeCodexChatAttachments: vi.fn(),
  materializeCodingChatHistory: vi.fn(),
  summarizeCodexChatRecoveryProgress: vi.fn(),
  updateCodexChatSessionIfLeaseHeld: vi.fn(),
}));

const cliMocks = vi.hoisted(() => ({
  ensureClaudeAcpAdapterInstalled: vi.fn(),
  killLeftoverClaudeTurnProcesses: vi.fn(),
}));

const acpMocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  createCodexChatProjector: vi.fn(),
  loadCodexChatAssistantMessageParts: vi.fn(),
}));

const historyMocks = vi.hoisted(() => ({
  loadCodingChatHistory: vi.fn(),
}));

const repoMocks = vi.hoisted(() => ({
  loadRepositoryBootstrap: vi.fn(),
  stageRepositoryBootstrap: vi.fn(),
}));

const sandboxMocks = vi.hoisted(() => ({
  armSandboxActiveTimeoutById: vi.fn(),
  armSandboxIdleTimeout: vi.fn(),
  createOrConnectSandbox: vi.fn(),
  isRetryableCommandStreamError: vi.fn(),
}));

const skillMocks = vi.hoisted(() => ({
  materializeClaudeSkillSnapshotsForSession: vi.fn(),
}));

const workflowSkillMocks = vi.hoisted(() => ({
  loadWorkflowTaskSkillBundles: vi.fn(),
}));

const taskMocks = vi.hoisted(() => ({
  buildTaskTerminalProjection: vi.fn(),
  buildTaskTurnCompletion: vi.fn(),
  closeTaskTurn: vi.fn(),
  finalizeTaskResult: vi.fn(),
  markTaskTurnRunning: vi.fn(),
}));

const wakeupMocks = vi.hoisted(() => ({
  enqueueCodexChatWakeup: vi.fn(),
  persistCodexChatScheduledWakeup: vi.fn(),
}));

vi.mock("@opencompany/db/claude-code-auth", () => ({
  loadClaudeCodeCredential: authMocks.loadClaudeCodeCredential,
  markClaudeCodeCredentialNeedsReauth: authMocks.markClaudeCodeCredentialNeedsReauth,
  markClaudeCodeCredentialValidated: authMocks.markClaudeCodeCredentialValidated,
}));

vi.mock("./claude-code-cli", () => ({
  buildClaudeAcpCommandEnv: () => ({ CLAUDE_CODE_OAUTH_TOKEN: "claude_token" }),
  ensureClaudeAcpAdapterInstalled: cliMocks.ensureClaudeAcpAdapterInstalled,
  killLeftoverClaudeTurnProcesses: cliMocks.killLeftoverClaudeTurnProcesses,
}));

vi.mock("./acp-harness", () => ({
  AcpHarness: class AcpHarness {
    runTurn(input: unknown) {
      return acpMocks.runTurn(input);
    }
  },
}));

vi.mock("./coding-agent-shared", () => ({
  buildGitHubCommandEnv: () => ({}),
  createKnownSecretRedactor: () => (value: string) => value,
}));

vi.mock("./coding-chat-history", async (importOriginal) => {
  const original = await importOriginal<typeof import("./coding-chat-history")>();
  return {
    ...original,
    loadCodingChatHistory: historyMocks.loadCodingChatHistory,
  };
});

vi.mock("./db", () => ({
  getDb: () => ({}),
}));

vi.mock("./codex-chat", () => ({
  claimCodexChatRecovery: chatMocks.claimCodexChatRecovery,
  codexChatAttachmentPromptLines: () => [],
  codexChatTurnLeaseIsHeld: chatMocks.codexChatTurnLeaseIsHeld,
  createTurnAbortCheck: (input: { shouldAbort?: () => Error | null }) => async () => {
    const error = input.shouldAbort?.();
    if (error) throw error;
  },
  CodexChatInterruptedError: class CodexChatInterruptedError extends Error {},
  loadCodexChatAttachments: chatMocks.loadCodexChatAttachments,
  loadCodexChatSessionSkills: chatMocks.loadCodexChatSessionSkills,
  loadGitHubAuthForUser: chatMocks.loadGitHubAuthForUser,
  markCodexChatSandboxTimeoutArmed: chatMocks.markCodexChatSandboxTimeoutArmed,
  materializeCodexChatAttachments: chatMocks.materializeCodexChatAttachments,
  materializeCodingChatHistory: chatMocks.materializeCodingChatHistory,
  summarizeCodexChatRecoveryProgress: chatMocks.summarizeCodexChatRecoveryProgress,
  updateCodexChatSessionIfLeaseHeld: chatMocks.updateCodexChatSessionIfLeaseHeld,
}));

vi.mock("./codex-chat-events", () => ({
  createCodexChatProjector: eventMocks.createCodexChatProjector,
  loadCodexChatAssistantMessageParts: eventMocks.loadCodexChatAssistantMessageParts,
}));

vi.mock("./codex-chat-wakeup", () => ({
  enqueueCodexChatWakeup: wakeupMocks.enqueueCodexChatWakeup,
  CODEX_CHAT_WAKEUP_MAX_DELAY_SECONDS: 3_600,
  CODEX_CHAT_WAKEUP_MIN_DELAY_SECONDS: 60,
  persistCodexChatScheduledWakeup: wakeupMocks.persistCodexChatScheduledWakeup,
  scheduledWakeupFromTurnSettings: () => null,
}));

vi.mock("./task-turn", () => ({
  buildTaskTerminalProjection: taskMocks.buildTaskTerminalProjection,
  buildTaskTurnCompletion: taskMocks.buildTaskTurnCompletion,
  closeTaskTurn: taskMocks.closeTaskTurn,
  finalizeTaskResult: taskMocks.finalizeTaskResult,
  markTaskTurnRunning: taskMocks.markTaskTurnRunning,
}));

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
}));

vi.mock("./codex-managed-skills", () => ({
  materializeClaudeSkillSnapshotsForSession: skillMocks.materializeClaudeSkillSnapshotsForSession,
}));

vi.mock("./workflow-skill-bundles", () => ({
  loadWorkflowTaskSkillBundles: workflowSkillMocks.loadWorkflowTaskSkillBundles,
}));

describe("isClaudeCodeAuthenticationFailure", () => {
  it.each([
    "Failed to authenticate. API Error: 401",
    "OAuth token has expired",
    "Unauthorized: login expired",
    "Invalid API key",
  ])("recognizes rejected credentials: %s", (message) => {
    expect(isClaudeCodeAuthenticationFailure(message)).toBe(true);
  });

  it.each([
    "You're out of usage credits · resets 10am (UTC)",
    "Credit balance is too low",
    "5-hour limit reached - resets 10am (UTC)",
  ])("keeps credentials connected for usage limits: %s", (message) => {
    expect(isClaudeCodeAuthenticationFailure(message)).toBe(false);
  });
});

describe("extractAcpScheduleWakeup", () => {
  it("reads a namespaced ScheduleWakeup call and clamps its delay", () => {
    expect(
      extractAcpScheduleWakeup(
        acpToolCallEvent({
          name: "mcp__opencompany_actions__ScheduleWakeup",
          rawInput: {
            delaySeconds: 9_000,
            reason: "Final check",
            prompt: "Check the deploy.",
          },
        }),
      ),
    ).toEqual({
      delaySeconds: 3_600,
      reason: "Final check",
      prompt: "Check the deploy.",
    });
  });

  it("clamps short delays to one minute", () => {
    expect(
      extractAcpScheduleWakeup(
        acpToolCallEvent({
          name: "ScheduleWakeup",
          rawInput: { delay_seconds: 5, reason: "Wait for the process" },
        }),
      ),
    ).toEqual({
      delaySeconds: 60,
      reason: "Wait for the process",
      prompt: "",
    });
  });

  it("ignores malformed tool input and unrelated raw events", () => {
    expect(
      extractAcpScheduleWakeup(
        acpToolCallEvent({
          name: "ScheduleWakeup",
          rawInput: { delay_seconds: "60", reason: "Wrong delay type" },
        }),
      ),
    ).toBeNull();
    expect(
      extractAcpScheduleWakeup(
        acpToolCallEvent({ name: "Bash", rawInput: { command: "sleep 5" } }),
      ),
    ).toBeNull();
    expect(extractAcpScheduleWakeup({ method: "session/prompt_result" })).toBeNull();
  });
});

describe("runClaudeCodeChatTurn sandbox lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.loadClaudeCodeCredential.mockResolvedValue({
      status: "connected",
      authJson: {
        token: "claude_token",
        subscriptionType: "max",
        rateLimitTier: "default",
      },
      updatedAt: new Date("2026-07-10T12:00:00.000Z"),
    });
    chatMocks.codexChatTurnLeaseIsHeld.mockResolvedValue(true);
    chatMocks.loadCodexChatAttachments.mockResolvedValue([]);
    chatMocks.loadCodexChatSessionSkills.mockResolvedValue([]);
    workflowSkillMocks.loadWorkflowTaskSkillBundles.mockResolvedValue([]);
    chatMocks.loadGitHubAuthForUser.mockResolvedValue(null);
    chatMocks.markCodexChatSandboxTimeoutArmed.mockResolvedValue(undefined);
    chatMocks.materializeCodexChatAttachments.mockResolvedValue({
      paths: [],
      localImages: [],
    });
    chatMocks.materializeCodingChatHistory.mockResolvedValue({
      materialization: {
        pathsByAttachmentId: new Map(),
        unavailableAttachmentIds: new Set(),
      },
      localImages: [],
    });
    chatMocks.summarizeCodexChatRecoveryProgress.mockReturnValue("");
    chatMocks.updateCodexChatSessionIfLeaseHeld.mockResolvedValue(true);
    historyMocks.loadCodingChatHistory.mockResolvedValue({
      messages: [],
      materializableAttachments: [],
      omittedTurnCount: 0,
      omittedAttachmentCount: 0,
    });
    cliMocks.ensureClaudeAcpAdapterInstalled.mockResolvedValue(undefined);
    cliMocks.killLeftoverClaudeTurnProcesses.mockResolvedValue(undefined);
    acpMocks.runTurn.mockImplementation(async (input) => {
      const turnInput = input as {
        onEngineSessionId: (sessionId: string) => Promise<void>;
        onRuntimeEvents: (events: Record<string, unknown>[]) => Promise<void>;
      };
      await turnInput.onEngineSessionId("claude_thread_1");
      await turnInput.onRuntimeEvents(acpSuccessfulTurnEvents("Completed over ACP."));
      return {
        sessionId: "claude_thread_1",
        loadedSession: true,
        promptResponse: { stopReason: "end_turn" },
        stderrTail: "",
      };
    });
    eventMocks.loadCodexChatAssistantMessageParts.mockResolvedValue([]);
    eventMocks.createCodexChatProjector.mockImplementation(
      (input: { normalizeEvent?: (event: Record<string, unknown>) => unknown }) => ({
        push: vi.fn(async (events: Record<string, unknown>[]) => {
          for (const event of events) input.normalizeEvent?.(event);
        }),
        finalize: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
        interrupted: vi.fn(async () => undefined),
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
    skillMocks.materializeClaudeSkillSnapshotsForSession.mockResolvedValue(undefined);
    taskMocks.buildTaskTerminalProjection.mockReturnValue({ taskId: "goat_task_1" });
    taskMocks.markTaskTurnRunning.mockResolvedValue(undefined);
  });

  it("configures Claude MCP against the runner with an attempt-and-lease capability", async () => {
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);

    await runClaudeCodeChatTurn({
      turn: claudeTurn(),
      session: claudeSession({
        workspaceId: "workspace_1",
        hostToolContractVersion: ACTION_HOST_TOOL_CONTRACT_VERSION,
      }),
      canonicalAttemptId: "attempt_1",
      env: env({ runnerPublicUrl: "https://runner.example.com" }),
    });

    const acpInput = acpMocks.runTurn.mock.calls[0]?.[0] as {
      mcpServers: Array<{
        name: string;
        url: string;
        headers: Array<{ name: string; value: string }>;
      }>;
    };
    const mcpServer = acpInput.mcpServers[0];
    expect(mcpServer).toMatchObject({ name: "opencompany_actions", type: "http" });
    expect(mcpServer?.url).toBe("https://runner.example.com/internal/goat/claude-actions");
    const ticket = mcpServer?.headers.find(
      (header) => header.name === "x-goat-action-ticket",
    )?.value;
    expect(
      verifyClaudeActionGatewayTicket({
        ticket: ticket ?? "",
        secret: "internal",
      }),
    ).toMatchObject({
      v: 2,
      codexChatSessionId: "goat_codex_chat_1",
      codexChatTurnId: "goat_codex_turn_1",
      attemptId: "attempt_1",
      leaseId: "lease_1",
    });
  });

  it("always runs Claude through the ACP harness", async () => {
    const projector = {
      push: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      interrupted: vi.fn(async () => undefined),
    };
    eventMocks.createCodexChatProjector.mockImplementationOnce(
      (input: { normalizeEvent?: (event: Record<string, unknown>) => unknown }) => ({
        ...projector,
        push: vi.fn(async (events: Record<string, unknown>[]) => {
          for (const event of events) input.normalizeEvent?.(event);
        }),
      }),
    );
    acpMocks.runTurn.mockImplementationOnce(
      async (input: {
        onEngineSessionId: (sessionId: string) => Promise<void>;
        onRuntimeEvents: (events: Record<string, unknown>[]) => Promise<void>;
        onPermissionRequest: (request: {
          id: number;
          method: "session/request_permission";
          params: Record<string, unknown>;
        }) => Promise<unknown>;
      }) => {
        await input.onEngineSessionId("acp_session_1");
        await expect(
          input.onPermissionRequest({
            id: 7,
            method: "session/request_permission",
            params: {
              options: [
                { optionId: "reject", kind: "reject_once" },
                { optionId: "allow", kind: "allow_once" },
              ],
            },
          }),
        ).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
        await input.onRuntimeEvents([
          { method: "session/started", params: { sessionId: "acp_session_1" } },
          {
            method: "session/update",
            params: {
              sessionId: "acp_session_1",
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: "message_1",
                content: { type: "text", text: "Completed over ACP." },
              },
            },
          },
          {
            method: "session/prompt_result",
            params: {
              sessionId: "acp_session_1",
              stopReason: "end_turn",
              usage: { inputTokens: 8, outputTokens: 4 },
            },
          },
        ]);
        return {
          sessionId: "acp_session_1",
          loadedSession: true,
          promptResponse: { stopReason: "end_turn" },
          stderrTail: "",
        };
      },
    );

    await expect(
      runClaudeCodeChatTurn({
        turn: claudeTurn(),
        session: claudeSession(),
        env: env(),
      }),
    ).resolves.toBe("settled");

    expect(cliMocks.ensureClaudeAcpAdapterInstalled).toHaveBeenCalledOnce();
    expect(acpMocks.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSessionId: "claude_thread_1",
        model: "claude-sonnet-5",
        permissionMode: "bypassPermissions",
      }),
    );
    expect(projector.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "acp_session_1",
        status: "success",
        result: "Completed over ACP.",
        usage: { input_tokens: 8, output_tokens: 4 },
      }),
    );
  });

  it("caps finished durable task sandbox parking at 5 minutes", async () => {
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);
    const harnessSpec = harnessSpecForClaudeTask();

    await expect(
      runClaudeCodeChatTurn({
        turn: claudeTurn(),
        session: claudeSession(),
        taskContext: {
          task: taskForHarness(harnessSpec),
          harnessSpec,
        },
        env: env({ codexChatIdleTimeoutMs: 30 * 60 * 1000 }),
      }),
    ).resolves.toBe("settled");

    expect(sandboxMocks.createOrConnectSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ idleTimeoutMs: 30 * 60 * 1000 }),
    );
    expect(sandboxMocks.armSandboxIdleTimeout).toHaveBeenCalledWith(sandbox, 300_000);
    expect(sandboxMocks.armSandboxActiveTimeoutById).not.toHaveBeenCalled();
  });

  it("materializes and invokes immutable workflow Skill bundles for durable tasks", async () => {
    const sandbox = fakeSandbox("sbx_existing");
    sandboxMocks.createOrConnectSandbox.mockResolvedValueOnce(sandbox);
    workflowSkillMocks.loadWorkflowTaskSkillBundles.mockResolvedValueOnce([
      {
        id: "skill_bundle_shadow_v1",
        name: "smooth-shadow-ring",
        description: "Polish elevation styles.",
        body: "Use layered shadows and a crisp ring.",
        files: [
          {
            path: "SKILL.md",
            content: new TextEncoder().encode("exact Skill document"),
            executable: false,
            sizeBytes: 20,
          },
        ],
      },
    ]);
    const harnessSpec = harnessSpecForClaudeTask();

    await runClaudeCodeChatTurn({
      turn: claudeTurn(),
      session: claudeSession(),
      taskContext: {
        task: taskForHarness(harnessSpec),
        harnessSpec,
      },
      env: env(),
    });

    expect(skillMocks.materializeClaudeSkillSnapshotsForSession).toHaveBeenCalledWith({
      sandbox,
      claudeWorkRoot: "/home/user/opencompany-goat/claude-chat",
      skills: [
        {
          name: "smooth-shadow-ring",
          files: [
            {
              path: "SKILL.md",
              content: new TextEncoder().encode("exact Skill document"),
              executable: false,
            },
          ],
        },
      ],
    });
    expect(acpMocks.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining(
          "/home/user/opencompany-goat/claude-chat/.claude/skills/smooth-shadow-ring/SKILL.md",
        ),
      }),
    );
  });

  it("defers an E2B command stream timeout instead of failing its durable task", async () => {
    const error = new Error("2: [unknown] The operation timed out.");
    error.name = "SandboxError";
    sandboxMocks.isRetryableCommandStreamError.mockReturnValueOnce(true);
    acpMocks.runTurn.mockRejectedValueOnce(error);
    const harnessSpec = harnessSpecForClaudeTask();

    await expect(
      runClaudeCodeChatTurn({
        turn: claudeTurn(),
        session: claudeSession(),
        taskContext: {
          task: taskForHarness(harnessSpec),
          harnessSpec,
        },
        env: env(),
      }),
    ).rejects.toMatchObject({
      name: CodexChatRetryableInfrastructureError.name,
      cause: error,
    });

    for (const result of eventMocks.createCodexChatProjector.mock.results) {
      expect(result.value.fail).not.toHaveBeenCalled();
      expect(result.value.finalize).not.toHaveBeenCalled();
    }
    expect(taskMocks.buildTaskTerminalProjection).not.toHaveBeenCalled();
  });

  it("projects a task wakeup as the next durable task turn", async () => {
    const harnessSpec = harnessSpecForClaudeTask();
    const turn = claudeTurn({ settings: { reasoningEffort: "high" } });
    const completion = { taskId: "goat_task_1", nextTurn: { id: "next_turn" } };
    taskMocks.closeTaskTurn.mockResolvedValueOnce({
      reportedOutcome: "needs_attention",
      outcomeComment: "Waiting for CI.",
    });
    taskMocks.finalizeTaskResult.mockResolvedValueOnce("PR opened; CI is running.");
    taskMocks.buildTaskTurnCompletion.mockReturnValueOnce(completion);
    eventMocks.createCodexChatProjector.mockImplementationOnce(
      (input: { normalizeEvent?: (event: unknown) => unknown }) => ({
        push: vi.fn(async (events: unknown[]) => {
          for (const event of events) input.normalizeEvent?.(event);
        }),
        finalize: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
        interrupted: vi.fn(async () => undefined),
      }),
    );
    acpMocks.runTurn.mockImplementationOnce(
      async (input: {
        onEngineSessionId: (sessionId: string) => Promise<void>;
        onRuntimeEvents: (events: Record<string, unknown>[]) => Promise<void>;
      }) => {
        await input.onEngineSessionId("claude_thread_1");
        await input.onRuntimeEvents([
          acpToolCallEvent({
            name: "ScheduleWakeup",
            rawInput: {
              delay_seconds: 600,
              reason: "Wait for CI",
              prompt: "Inspect PR #42.",
            },
          }),
          ...acpSuccessfulTurnEvents("PR opened; CI is running."),
        ]);
        return {
          sessionId: "claude_thread_1",
          loadedSession: true,
          promptResponse: { stopReason: "end_turn" },
          stderrTail: "",
        };
      },
    );

    await expect(
      runClaudeCodeChatTurn({
        turn,
        session: claudeSession(),
        taskContext: {
          task: taskForHarness(harnessSpec),
          harnessSpec,
        },
        env: env(),
      }),
    ).resolves.toBe("settled");

    expect(taskMocks.buildTaskTurnCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledWakeup: {
          wakeup: {
            delaySeconds: 600,
            reason: "Wait for CI",
            prompt: "Inspect PR #42.",
          },
          parentSettings: { reasoningEffort: "high" },
        },
      }),
    );
    expect(wakeupMocks.persistCodexChatScheduledWakeup).toHaveBeenCalledOnce();
    expect(wakeupMocks.enqueueCodexChatWakeup).not.toHaveBeenCalled();
  });
});

function acpToolCallEvent(input: { name: string; rawInput: Record<string, unknown> }) {
  return {
    method: "session/update",
    params: {
      sessionId: "claude_thread_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool_1",
        title: input.name,
        name: input.name,
        rawInput: input.rawInput,
      },
    },
  };
}

function acpSuccessfulTurnEvents(result: string) {
  return [
    { method: "session/started", params: { sessionId: "claude_thread_1" } },
    {
      method: "session/update",
      params: {
        sessionId: "claude_thread_1",
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
        sessionId: "claude_thread_1",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    },
  ];
}

function fakeSandbox(sandboxId: string) {
  return {
    sandboxId,
    commands: {
      run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    },
    files: {
      write: vi.fn(async (_path: string, _content: string) => undefined),
    },
  };
}

function claudeSession(overrides: Partial<CodexChatSession> = {}): CodexChatSession {
  const now = new Date("2026-07-10T12:00:00.000Z");
  return {
    id: "goat_codex_chat_1",
    userWorkosId: "user_1",
    chatSessionId: "goat_chat_1",
    engine: "claude_code",
    model: "claude-sonnet-5",
    brainRef: null,
    workspaceId: null,
    hostToolContractVersion: null,
    sandboxId: "sbx_existing",
    codexThreadId: "claude_thread_1",
    activeTurnId: "goat_codex_turn_1",
    status: "running",
    error: null,
    sandboxTimeoutArmedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function claudeTurn(overrides: Partial<CodexChatTurn> = {}): CodexChatTurn {
  const now = new Date("2026-07-10T12:00:00.000Z");
  return {
    id: "goat_codex_turn_1",
    userWorkosId: "user_1",
    codexChatSessionId: "goat_codex_chat_1",
    chatSessionId: "goat_chat_1",
    userMessageId: "goat_chat_msg_user",
    assistantMessageId: "goat_chat_msg_assistant",
    codexTurnId: null,
    status: "running",
    prompt: "Run the workflow step.",
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
    leaseExpiresAt: new Date("2026-07-10T12:05:00.000Z"),
    runAfter: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function harnessSpecForClaudeTask(): HarnessSpec {
  return {
    schemaVersion: "goat.harness.v1",
    engine: "claude_code",
    model: "anthropic/claude-sonnet-5",
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
      skillIds: ["smooth-shadow-ring"],
      skillBundleIds: ["skill_bundle_shadow_v1"],
      currentStepIndex: 0,
      completedStepCount: 0,
      steps: [
        {
          index: 0,
          title: "Implement",
          engine: "claude_code",
          model: "anthropic/claude-sonnet-5",
          systemPrompt: "Implement and verify the change.",
          systemBlocks: ["Implement and verify the change."],
          skillIds: ["smooth-shadow-ring"],
          skillBundleIds: ["skill_bundle_shadow_v1"],
        },
      ],
    },
  };
}

function taskForHarness(harnessSpec: HarnessSpec): Task {
  const now = new Date("2026-07-10T12:00:00.000Z");
  return {
    id: "goat_task_1",
    displayId: "TASK-1",
    name: "Ship workflow",
    userWorkosId: "user_1",
    workspaceId: "workspace_1",
    prompt: "Ship the requested change.",
    source: "workflow",
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
    apiOrigin: "http://localhost:3001",
    apiInternalToken: "api-internal-secret",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: "codex",
    exaApiKey: "exa",
    browserEnabled: false,
    codexE2bTemplate: undefined,
    codexTimeoutMs: 1_200_000,
    codexModel: "gpt-5.5",
    codexChatIdleTimeoutMs: 300_000,
    jobLeaseTtlMs: 300_000,
    taskWorkerEnabled: false,
    workerConcurrency: 2,
    port: 3040,
    allowedOrigins: ["http://localhost:3000"],
    instanceId: "runner_1",
    ...overrides,
  };
}
