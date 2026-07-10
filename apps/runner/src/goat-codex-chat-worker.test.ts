import type { GoatCodexChatSession, GoatCodexChatTurn } from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import { runClaimedTurn } from "./goat-codex-chat-worker";

const sessionRows = vi.hoisted(() => [] as GoatCodexChatSession[]);

const dbMock = vi.hoisted(() => {
  const db = {
    select: vi.fn(() => db),
    from: vi.fn(() => db),
    where: vi.fn(() => db),
    limit: vi.fn(async () => sessionRows),
  };
  return db;
});

const chatMocks = vi.hoisted(() => ({
  runGoatCodexChatTurn: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  fail: vi.fn(),
  createGoatCodexChatProjector: vi.fn(() => ({ fail: eventMocks.fail })),
  loadCodexChatAssistantMessageParts: vi.fn(async () => []),
}));

vi.mock("./db", () => ({
  getDb: () => dbMock,
}));

vi.mock("./goat-codex-chat", () => ({
  runGoatCodexChatTurn: chatMocks.runGoatCodexChatTurn,
}));

vi.mock("./goat-codex-chat-events", () => ({
  createGoatCodexChatProjector: eventMocks.createGoatCodexChatProjector,
  loadCodexChatAssistantMessageParts: eventMocks.loadCodexChatAssistantMessageParts,
}));

describe("runClaimedTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionRows.length = 0;
    sessionRows.push(session());
    chatMocks.runGoatCodexChatTurn.mockResolvedValue(undefined);
  });

  it("runs first attempts normally", async () => {
    await runClaimedTurn(turn({ attempts: 1 }), env());

    const input = chatMocks.runGoatCodexChatTurn.mock.calls[0]?.[0];
    expect(input).toEqual(
      expect.objectContaining({ turn: expect.objectContaining({ attempts: 1 }) }),
    );
    expect(input).not.toHaveProperty("recovery");
  });

  it("uses durable continuation for the first reclaimed attempt", async () => {
    await runClaimedTurn(turn({ attempts: 2 }), env());

    expect(chatMocks.runGoatCodexChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turn: expect.objectContaining({ attempts: 2 }),
        recovery: { reason: "lease_reclaimed" },
      }),
    );
    expect(eventMocks.fail).not.toHaveBeenCalled();
  });

  it("fails cleanly when recovery is reclaimed again", async () => {
    await runClaimedTurn(turn({ attempts: 3 }), env());

    expect(chatMocks.runGoatCodexChatTurn).not.toHaveBeenCalled();
    expect(eventMocks.fail).toHaveBeenCalledWith(
      "Codex was interrupted by a runner restart. Send your message again to continue.",
    );
  });
});

function turn(overrides: Partial<GoatCodexChatTurn> = {}): GoatCodexChatTurn {
  const now = new Date("2026-07-10T09:00:00.000Z");
  return {
    id: "goat_codex_chat_turn_1",
    userWorkosId: "user_1",
    codexChatSessionId: "goat_codex_chat_1",
    chatSessionId: "goat_chat_1",
    userMessageId: "goat_chat_msg_user",
    assistantMessageId: "goat_chat_msg_assistant",
    codexTurnId: "turn_1",
    status: "running",
    prompt: "Fix the bug.",
    settings: {},
    error: null,
    interruptRequestedAt: null,
    attempts: 1,
    leaseId: "lease_1",
    leaseOwner: "runner_1",
    leaseExpiresAt: new Date("2026-07-10T09:05:00.000Z"),
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function session(overrides: Partial<GoatCodexChatSession> = {}): GoatCodexChatSession {
  const now = new Date("2026-07-10T09:00:00.000Z");
  return {
    id: "goat_codex_chat_1",
    userWorkosId: "user_1",
    chatSessionId: "goat_chat_1",
    model: "gpt-5.5",
    sandboxId: "sbx_1",
    codexThreadId: "thread_1",
    activeTurnId: "goat_codex_chat_turn_1",
    status: "running",
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function env(overrides: Partial<RunnerEnv> = {}): RunnerEnv {
  return {
    databaseUrl: "postgres://test",
    internalToken: "internal",
    streamTokenSecret: "stream",
    e2bApiKey: "e2b",
    vercelAiGatewayApiKey: "gateway",
    openaiCodexApiKey: "codex",
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
    goatCodexChatIdleTimeoutMs: 1_800_000,
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
