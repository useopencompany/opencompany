import type { CodexChatSession, CodexChatTurn, HarnessSpec, Task } from "@opencompany/db/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractClaudeScheduleWakeup, runClaudeCodeChatTurn } from "./claude-code-chat";
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
  summarizeCodexChatRecoveryProgress: vi.fn(),
  updateCodexChatSessionIfLeaseHeld: vi.fn(),
}));

const cliMocks = vi.hoisted(() => ({
  ensureClaudeInstalled: vi.fn(),
  killLeftoverClaudeTurnProcesses: vi.fn(),
  runClaudeCodeCliProcess: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  createCodexChatProjector: vi.fn(),
  loadCodexChatAssistantMessageParts: vi.fn(),
}));

const repoMocks = vi.hoisted(() => ({
  loadRepositoryBootstrap: vi.fn(),
  stageRepositoryBootstrap: vi.fn(),
}));

const sandboxMocks = vi.hoisted(() => ({
  armSandboxActiveTimeoutById: vi.fn(),
  armSandboxIdleTimeout: vi.fn(),
  createOrConnectSandbox: vi.fn(),
}));

const skillMocks = vi.hoisted(() => ({
  materializeCodexSkillSnapshotsForSession: vi.fn(),
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

vi.mock("@opencompany/db/harness", () => ({
  getWorkflowHarnessSkillSnapshots: () => [],
}));

vi.mock("./claude-code-cli", () => ({
  buildClaudeCommandEnv: () => ({ CLAUDE_CODE_OAUTH_TOKEN: "claude_token" }),
  buildClaudeTurnCommand: () => "claude -p prompt",
  ensureClaudeInstalled: cliMocks.ensureClaudeInstalled,
  killLeftoverClaudeTurnProcesses: cliMocks.killLeftoverClaudeTurnProcesses,
  runClaudeCodeCliProcess: cliMocks.runClaudeCodeCliProcess,
}));

vi.mock("./coding-agent-shared", () => ({
  buildGitHubCommandEnv: () => ({}),
  createKnownSecretRedactor: () => (value: string) => value,
}));

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

vi.mock("./repo-bootstrap", () => ({
  loadRepositoryBootstrap: repoMocks.loadRepositoryBootstrap,
  stageRepositoryBootstrap: repoMocks.stageRepositoryBootstrap,
}));

vi.mock("./sandbox", () => ({
  armSandboxActiveTimeoutById: sandboxMocks.armSandboxActiveTimeoutById,
  armSandboxIdleTimeout: sandboxMocks.armSandboxIdleTimeout,
  createOrConnectSandbox: sandboxMocks.createOrConnectSandbox,
}));

vi.mock("./codex-managed-skills", () => ({
  materializeCodexSkillSnapshotsForSession: skillMocks.materializeCodexSkillSnapshotsForSession,
}));

describe("extractClaudeScheduleWakeup", () => {
  it("uses the last valid ScheduleWakeup call and clamps its delay", () => {
    expect(
      extractClaudeScheduleWakeup(
        assistantEvent([
          {
            type: "tool_use",
            name: "ScheduleWakeup",
            input: { delay_seconds: 120, reason: "First check", prompt: "Check CI." },
          },
          {
            type: "tool_use",
            name: "ScheduleWakeup",
            input: { delaySeconds: 9_000, reason: "Final check", prompt: "Check the deploy." },
          },
        ]),
      ),
    ).toEqual({
      delaySeconds: 3_600,
      reason: "Final check",
      prompt: "Check the deploy.",
    });
  });

  it("clamps short delays to one minute", () => {
    expect(
      extractClaudeScheduleWakeup(
        assistantEvent([
          {
            type: "tool_use",
            name: "ScheduleWakeup",
            input: { delay_seconds: 5, reason: "Wait for the process" },
          },
        ]),
      ),
    ).toEqual({
      delaySeconds: 60,
      reason: "Wait for the process",
      prompt: "",
    });
  });

  it("ignores malformed tool input and unrelated raw events", () => {
    expect(
      extractClaudeScheduleWakeup(
        assistantEvent([
          { type: "tool_use", name: "Bash", input: { command: "sleep 5" } },
          {
            type: "tool_use",
            name: "ScheduleWakeup",
            input: { delay_seconds: "60", reason: "Wrong delay type" },
          },
          {
            type: "tool_use",
            name: "ScheduleWakeup",
            input: { delay_seconds: 60, reason: "   " },
          },
        ]),
      ),
    ).toBeNull();
    expect(extractClaudeScheduleWakeup({ type: "result" })).toBeNull();
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
    chatMocks.loadGitHubAuthForUser.mockResolvedValue(null);
    chatMocks.markCodexChatSandboxTimeoutArmed.mockResolvedValue(undefined);
    chatMocks.materializeCodexChatAttachments.mockResolvedValue({
      paths: [],
      localImages: [],
    });
    chatMocks.summarizeCodexChatRecoveryProgress.mockReturnValue("");
    chatMocks.updateCodexChatSessionIfLeaseHeld.mockResolvedValue(true);
    cliMocks.ensureClaudeInstalled.mockResolvedValue(undefined);
    cliMocks.killLeftoverClaudeTurnProcesses.mockResolvedValue(undefined);
    cliMocks.runClaudeCodeCliProcess.mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      killed: false,
      stderrTail: "",
    });
    eventMocks.loadCodexChatAssistantMessageParts.mockResolvedValue([]);
    eventMocks.createCodexChatProjector.mockReturnValue({
      push: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
      interrupted: vi.fn(async () => undefined),
    });
    repoMocks.loadRepositoryBootstrap.mockResolvedValue({
      configs: [],
      promptFragment: "",
      secretValues: [],
    });
    repoMocks.stageRepositoryBootstrap.mockResolvedValue(undefined);
    sandboxMocks.armSandboxActiveTimeoutById.mockResolvedValue(true);
    sandboxMocks.armSandboxIdleTimeout.mockResolvedValue(true);
    sandboxMocks.createOrConnectSandbox.mockResolvedValue(fakeSandbox("sbx_existing"));
    skillMocks.materializeCodexSkillSnapshotsForSession.mockResolvedValue(undefined);
    taskMocks.buildTaskTerminalProjection.mockReturnValue({ taskId: "goat_task_1" });
    taskMocks.markTaskTurnRunning.mockResolvedValue(undefined);
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
    cliMocks.runClaudeCodeCliProcess.mockImplementationOnce(
      async (input: { onEvent: (event: unknown) => Promise<void> }) => {
        await input.onEvent(
          assistantEvent([
            {
              type: "tool_use",
              name: "ScheduleWakeup",
              input: {
                delay_seconds: 600,
                reason: "Wait for CI",
                prompt: "Inspect PR #42.",
              },
            },
          ]),
        );
        await input.onEvent({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "PR opened; CI is running.",
          session_id: "claude_thread_1",
          usage: { input_tokens: 10, output_tokens: 20 },
        });
        return { exitCode: 0, timedOut: false, killed: false, stderrTail: "" };
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

function assistantEvent(content: unknown[]) {
  return {
    type: "assistant",
    message: { id: "msg_1", content },
  };
}

function fakeSandbox(sandboxId: string) {
  return {
    sandboxId,
    commands: {
      run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    },
    files: {
      write: vi.fn(async () => undefined),
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
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: "codex",
    publicUrl: undefined,
    llmBrokerEnabled: true,
    exaApiKey: "exa",
    browserEnabled: false,
    ampE2bTemplate: undefined,
    codexE2bTemplate: undefined,
    e2bSandboxIdleTimeoutMs: 30_000,
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
