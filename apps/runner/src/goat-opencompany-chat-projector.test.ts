import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoatCodexChatLeaseLostError } from "./goat-codex-chat-errors";
import { createGoatOpenCompanyChatProjector } from "./goat-opencompany-chat-projector";

const dbMock = vi.hoisted(() => ({
  execute: vi.fn(),
}));
const usageMocks = vi.hoisted(() => ({
  captureModelSpend: vi.fn(async () => undefined),
  captureLlmUsage: vi.fn(async () => undefined),
  recordCreditDebit: vi.fn(async () => ({ ok: true })),
  recordModelCost: vi.fn(),
  recordModelUsageTokens: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: () => dbMock,
}));

vi.mock("@opencompany/db/goat-credits", () => ({
  recordGoatCreditDebit: usageMocks.recordCreditDebit,
}));

vi.mock("@opencompany/analytics/goat/server", () => ({
  captureGoatModelSpendRecorded: usageMocks.captureModelSpend,
  captureGoatLlmUsageRecorded: usageMocks.captureLlmUsage,
}));

vi.mock("@opencompany/goat-observability", () => ({
  recordGoatModelCost: usageMocks.recordModelCost,
  recordGoatModelUsageTokens: usageMocks.recordModelUsageTokens,
}));

describe("createGoatOpenCompanyChatProjector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.execute.mockResolvedValue({ rows: [{ id: "updated" }] });
  });

  it("lease-guards every streamed assistant message update", async () => {
    const projector = createProjector();

    await projector.project({
      parts: [{ type: "text", text: "Partial answer", state: "streaming" }],
    });

    const statement = sqlText(dbMock.execute.mock.calls[0]?.[0]);
    expect(statement).toContain("UPDATE goat.chat_messages AS message");
    expect(statement).toContain("lease_turn.lease_id");
    expect(statement).toContain("lease_turn.lease_owner");
    expect(statement).toContain("lease_turn.status = 'running'");
    expect(JSON.stringify(queryValues(dbMock.execute.mock.calls[0]?.[0]))).toContain(
      "opencompany.chat.debug.v1",
    );
  });

  it("treats a missing lease row as lease loss before the stream can continue", async () => {
    dbMock.execute.mockResolvedValueOnce({ rows: [] });

    await expect(createProjector().checkAbort()).rejects.toBeInstanceOf(
      GoatCodexChatLeaseLostError,
    );
  });

  it("persists partial output as aborted and settles an interrupted turn", async () => {
    const projector = createProjector();

    await projector.interrupted({
      parts: [{ type: "text", text: "Partial answer", state: "done" }],
    });

    expect(dbMock.execute).toHaveBeenCalledTimes(2);
    expect(queryValues(dbMock.execute.mock.calls[0]?.[0])).toEqual(
      expect.arrayContaining([expect.stringContaining('"aborted":true')]),
    );
    const settleStatement = sqlText(dbMock.execute.mock.calls[1]?.[0]);
    expect(settleStatement).toContain("WITH settled_turn AS");
    expect(settleStatement).toContain("next_queued_turn AS");
    expect(queryValues(dbMock.execute.mock.calls[1]?.[0])).toContain("interrupted");
  });

  it("keeps persisted assistant parts when a reclaimed turn finalizes an empty interrupt", async () => {
    dbMock.execute
      .mockResolvedValueOnce({
        rows: [
          {
            content: "Briefing delivered.",
            debug_trace: {
              schemaVersion: "opencompany.chat.debug.v1",
              uiMessageParts: [{ type: "text", text: "Briefing delivered.", state: "done" }],
              usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
            },
          },
        ],
      })
      .mockResolvedValue({ rows: [{ id: "updated" }] });
    const projector = createProjector();

    await projector.interrupted({ parts: [] });

    expect(dbMock.execute).toHaveBeenCalledTimes(3);
    const hydrateStatement = sqlText(dbMock.execute.mock.calls[0]?.[0]);
    expect(hydrateStatement).toContain("SELECT content, debug_trace");
    expect(hydrateStatement).toContain("lease_turn.status = 'running'");
    expect(queryValues(dbMock.execute.mock.calls[1]?.[0])).toEqual(
      expect.arrayContaining([
        "Briefing delivered.",
        expect.stringContaining('"uiMessageParts":[{"type":"text","text":"Briefing delivered."'),
        expect.stringContaining('"aborted":true'),
      ]),
    );
    expect(queryValues(dbMock.execute.mock.calls[2]?.[0])).toContain("interrupted");
  });

  it("records every finish-step cost with a replay-safe turn and step key", async () => {
    await createProjector().recordStepUsage({
      stepIndex: 2,
      usage: {
        inputTokens: 1_000,
        outputTokens: 200,
        totalTokens: 1_200,
        inputTokenDetails: {
          noCacheTokens: 900,
          cacheReadTokens: 100,
          cacheWriteTokens: 0,
        },
        outputTokenDetails: {
          textTokens: 200,
          reasoningTokens: 0,
        },
      },
    });

    expect(usageMocks.recordModelCost).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          "goat.engine": "opencompany",
          "goat.surface": "chat",
        }),
      }),
    );
    expect(usageMocks.recordCreditDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "chat_model_usage",
        idempotencyKey: "chat:user_message_1:durable:turn_1:step:2",
        chatSessionId: "goat_chat_1",
      }),
    );
    expect(usageMocks.captureLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "user_1",
        workspaceId: "workspace_1",
        surface: "chat",
        stage: "generation",
        sessionId: "goat_chat_1",
        messageId: "user_message_1",
        turnId: "turn_1",
        stepIndex: 2,
        modelProvider: "vercel-ai-gateway",
        model: "anthropic/claude-sonnet-5",
        inputTokens: 1_000,
        inputNoCacheTokens: 900,
        inputCacheReadTokens: 100,
        inputCacheWriteTokens: 0,
        outputTokens: 200,
        outputTextTokens: 200,
        outputReasoningTokens: 0,
        totalTokens: 1_200,
      }),
    );
    expect(usageMocks.captureModelSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        billingSource: "chat_model_usage",
        surface: "chat",
        stage: "generation",
        engine: "opencompany",
        model: "anthropic/claude-sonnet-5",
        chatSessionId: "goat_chat_1",
        messageId: "user_message_1",
      }),
    );
  });
});

function createProjector() {
  return createGoatOpenCompanyChatProjector({
    target: {
      userWorkosId: "user_1",
      codexChatSessionId: "goat_codex_chat_1",
      chatSessionId: "goat_chat_1",
      turnId: "turn_1",
      userMessageId: "user_message_1",
      assistantMessageId: "assistant_message_1",
      workspaceId: "workspace_1",
      model: "anthropic/claude-sonnet-5",
      leaseId: "lease_1",
      leaseOwner: "runner_1",
      turnStartedAt: new Date("2026-07-30T10:00:00.000Z"),
    },
  });
}

function sqlText(query: unknown): string {
  if (typeof query === "string") return query;
  if (!query || typeof query !== "object") return "";
  if ("value" in query && Array.isArray((query as { value?: unknown }).value)) {
    return ((query as { value: unknown[] }).value ?? []).map(sqlText).join("");
  }
  if ("queryChunks" in query && Array.isArray((query as { queryChunks?: unknown }).queryChunks)) {
    return ((query as { queryChunks: unknown[] }).queryChunks ?? []).map(sqlText).join("");
  }
  return "";
}

function queryValues(query: unknown) {
  const values: unknown[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") {
      if (typeof value !== "undefined") values.push(value);
      return;
    }
    if ("queryChunks" in value && Array.isArray((value as { queryChunks?: unknown }).queryChunks)) {
      for (const chunk of (value as { queryChunks: unknown[] }).queryChunks) visit(chunk);
      return;
    }
    if ("value" in value && Array.isArray((value as { value?: unknown }).value)) return;
    values.push(value);
  };
  visit(query);
  return values;
}
