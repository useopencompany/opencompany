import type { GoatCodexChatSession, GoatCodexChatTurn } from "@opencompany/db/goat-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";
import {
  claimNextGoatCodexChatTurn,
  resolveGoatCodexChatWorkerConcurrency,
  runClaimedTurn,
} from "./goat-codex-chat-worker";

const sessionRows = vi.hoisted(() => [] as GoatCodexChatSession[]);

const dbMock = vi.hoisted(() => {
  const db = {
    execute: vi.fn(),
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

const telemetry = vi.hoisted(() => ({ recordGoatHistogram: vi.fn() }));

vi.mock("@opencompany/goat-observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opencompany/goat-observability")>();
  return { ...actual, recordGoatHistogram: telemetry.recordGoatHistogram };
});

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

describe("claimNextGoatCodexChatTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.execute.mockResolvedValue({ rows: [claimedTurnRow()] });
  });

  it("atomically moves the claimed session from queued to starting", async () => {
    await expect(
      claimNextGoatCodexChatTurn({ leaseOwner: "runner_1", leaseTtlMs: 300_000 }),
    ).resolves.toMatchObject({ id: "goat_codex_chat_turn_1", status: "running", attempts: 1 });

    const statement = sqlText(dbMock.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("claimed AS");
    expect(statement).toContain("UPDATE goat.codex_chat_sessions AS session");
    expect(statement).toContain("SET status = 'starting'");
  });
});

describe("resolveGoatCodexChatWorkerConcurrency", () => {
  it("uses the runner-wide concurrency by default", () => {
    expect(resolveGoatCodexChatWorkerConcurrency({ workerConcurrency: 40 })).toBe(40);
  });

  it("honors an explicit test override", () => {
    expect(resolveGoatCodexChatWorkerConcurrency({ workerConcurrency: 40 }, 2)).toBe(2);
  });
});

describe("runClaimedTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionRows.length = 0;
    sessionRows.push(session());
    chatMocks.runGoatCodexChatTurn.mockResolvedValue(undefined);
  });

  it("runs first attempts normally", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T09:00:05.000Z"));
    try {
      await runClaimedTurn(turn({ attempts: 1 }), env());
    } finally {
      vi.useRealTimers();
    }

    const input = chatMocks.runGoatCodexChatTurn.mock.calls[0]?.[0];
    expect(input).toEqual(
      expect.objectContaining({ turn: expect.objectContaining({ attempts: 1 }) }),
    );
    expect(input).not.toHaveProperty("recovery");
    expect(telemetry.recordGoatHistogram).toHaveBeenCalledWith(
      "goat.codex_chat.queue_wait_ms",
      5_000,
      {
        "goat.engine": "codex",
        "goat.model": "gpt-5.5",
        "goat.status": "running",
        "goat.attempt": 1,
      },
    );
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
    expect(telemetry.recordGoatHistogram).not.toHaveBeenCalled();
  });

  it("fails cleanly when recovery is reclaimed again", async () => {
    await runClaimedTurn(turn({ attempts: 3 }), env());

    expect(chatMocks.runGoatCodexChatTurn).not.toHaveBeenCalled();
    expect(eventMocks.fail).toHaveBeenCalledWith(
      "Codex was interrupted by a runner restart. Send your message again to continue.",
    );
  });
});

function claimedTurnRow() {
  return {
    id: "goat_codex_chat_turn_1",
    user_workos_id: "user_1",
    codex_chat_session_id: "goat_codex_chat_1",
    chat_session_id: "goat_chat_1",
    user_message_id: "goat_chat_msg_user",
    assistant_message_id: "goat_chat_msg_assistant",
    codex_turn_id: null,
    status: "running",
    prompt: "Fix the bug.",
    settings: {},
    error: null,
    interrupt_requested_at: null,
    attempts: 1,
    lease_id: "lease_1",
    lease_owner: "runner_1",
    lease_expires_at: "2026-07-10T09:05:00.000Z",
    completed_at: null,
    created_at: "2026-07-10T09:00:00.000Z",
    updated_at: "2026-07-10T09:00:00.000Z",
  };
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (
        chunk &&
        typeof chunk === "object" &&
        "value" in chunk &&
        Array.isArray((chunk as { value?: unknown }).value)
      ) {
        return ((chunk as { value: unknown[] }).value ?? []).join("");
      }
      return "";
    })
    .join("");
}

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
