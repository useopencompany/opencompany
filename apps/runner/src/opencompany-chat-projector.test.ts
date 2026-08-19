import type { RunAttempt, RunEvent, RunExecutionRepository } from "@opencompany/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexChatLeaseLostError } from "./codex-chat-errors";
import { createProductChatProjector } from "./opencompany-chat-projector";

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
const startAttempt = vi.fn(
  async (): Promise<RunAttempt | null> => ({
    id: "attempt_1",
    runId: "turn_1",
    number: 1,
    status: "running",
    workerId: "runner_1",
    deployVersion: null,
    startedAt: new Date("2026-07-30T10:00:00.000Z"),
    completedAt: null,
    errorCode: null,
    errorMessage: null,
  }),
);
const appendEvents = vi.fn(
  async (
    input: Parameters<RunExecutionRepository["appendEvents"]>[0],
  ): Promise<readonly RunEvent[]> =>
    input.events.map(
      (event, index): RunEvent => ({
        ...event,
        runId: input.runId,
        attemptId: input.attemptId,
        sequence: index + 1,
        createdAt: new Date("2026-07-30T10:00:00.000Z"),
      }),
    ),
);
const executionMock: RunExecutionRepository = {
  startAttempt,
  appendEvents,
  pauseForApprovals: vi.fn(async () => []),
  finishAttempt: vi.fn(async () => null),
};

vi.mock("./db", () => ({
  getDb: () => dbMock,
}));

vi.mock("@opencompany/db/credits", () => ({
  recordCreditDebit: usageMocks.recordCreditDebit,
}));

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductModelSpendRecorded: usageMocks.captureModelSpend,
  captureProductLlmUsageRecorded: usageMocks.captureLlmUsage,
}));

vi.mock("@opencompany/telemetry", () => ({
  recordModelCost: usageMocks.recordModelCost,
  recordModelUsageTokens: usageMocks.recordModelUsageTokens,
}));

describe("createProductChatProjector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.execute.mockResolvedValue({ rows: [{ id: "updated" }] });
  });

  it("lease-guards every streamed assistant message update", async () => {
    const projector = createProjector();
    await projector.started();

    await projector.project({
      parts: [{ type: "text", text: "Partial answer", state: "streaming" }],
    });

    const projectionQuery = dbMock.execute.mock.calls.find(([query]) =>
      sqlText(query).includes("UPDATE goat.chat_messages AS message"),
    )?.[0];
    const statement = sqlText(projectionQuery);
    expect(statement).toContain("UPDATE goat.chat_messages AS message");
    expect(statement).toContain("lease_turn.lease_id");
    expect(statement).toContain("lease_turn.lease_owner");
    expect(statement).toContain("lease_turn.status = 'running'");
    expect(JSON.stringify(queryValues(projectionQuery))).toContain("opencompany.chat.debug.v1");
    expect(executionMock.appendEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "turn_1",
        attemptId: "attempt_1",
        events: [
          expect.objectContaining({
            type: "message.content_updated",
            payload: expect.objectContaining({ content: "Partial answer", complete: false }),
          }),
        ],
      }),
    );
  });

  it("emits each semantic tool transition once", async () => {
    const projector = createProjector();
    await projector.started();
    await projector.project({
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "tool_call_1",
          state: "input-available",
        },
      ],
    });
    await projector.project({
      parts: [
        {
          type: "tool-web_search",
          toolCallId: "tool_call_1",
          state: "output-available",
        },
      ],
    });

    const eventTypes = vi
      .mocked(executionMock.appendEvents)
      .mock.calls.flatMap(([call]) => call.events.map((event) => event.type));
    expect(eventTypes.filter((type) => type === "tool.started")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "tool.completed")).toHaveLength(1);
  });

  it("treats a missing lease row as lease loss before the stream can continue", async () => {
    dbMock.execute.mockResolvedValueOnce({ rows: [] });

    await expect(createProjector().checkAbort()).rejects.toBeInstanceOf(CodexChatLeaseLostError);
  });

  it("atomically pauses the Run for its persisted approval requests", async () => {
    vi.mocked(executionMock.pauseForApprovals).mockImplementationOnce(async (input) =>
      input.approvals.map((approval) => ({
        ...approval,
        runId: input.runId,
        attemptId: input.attemptId,
        options: approval.options ?? null,
        status: "pending" as const,
        resolution: null,
        response: null,
        createdAt: new Date("2026-07-30T10:00:00.000Z"),
        updatedAt: new Date("2026-07-30T10:00:00.000Z"),
        resolvedAt: null,
      })),
    );
    const projector = createProjector();
    await projector.started();

    await projector.paused(
      {
        parts: [
          {
            type: "tool-use_action",
            toolCallId: "tool_call_1",
            state: "approval-requested",
            approval: { id: "approval_1" },
          },
        ],
      },
      [
        {
          id: "approval_1",
          toolCallId: "tool_call_1",
          kind: "use_action",
          prompt: "Approve crm.update?",
          options: ["approved", "denied"],
        },
      ],
    );

    expect(executionMock.pauseForApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "turn_1",
        attemptId: "attempt_1",
        leaseId: "lease_1",
        approvals: [expect.objectContaining({ id: "approval_1" })],
      }),
    );
    expect(executionMock.appendEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            type: "message.content_updated",
            payload: expect.objectContaining({ complete: true }),
          }),
          expect.objectContaining({ type: "tool.started" }),
        ],
      }),
    );
    expect(vi.mocked(executionMock.appendEvents).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(executionMock.pauseForApprovals).mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("persists partial output as aborted and settles an interrupted turn", async () => {
    const projector = createProjector();
    await projector.started();

    await projector.interrupted({
      parts: [{ type: "text", text: "Partial answer", state: "done" }],
    });

    expect(dbMock.execute).toHaveBeenCalledTimes(3);
    expect(queryValues(dbMock.execute.mock.calls[1]?.[0])).toEqual(
      expect.arrayContaining([expect.stringContaining('"aborted":true')]),
    );
    const settleStatement = sqlText(dbMock.execute.mock.calls[2]?.[0]);
    expect(settleStatement).toContain("WITH settled_turn AS");
    expect(settleStatement).toContain("finished_canonical_attempt AS");
    expect(settleStatement).toContain("inserted_canonical_events AS");
    expect(settleStatement).toContain("next_queued_turn AS");
    expect(queryValues(dbMock.execute.mock.calls[2]?.[0])).toContain("interrupted");
  });

  it("keeps persisted assistant parts when a reclaimed turn finalizes an empty interrupt", async () => {
    const projector = createProjector();
    await projector.started();
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

    await projector.interrupted({ parts: [] });

    expect(dbMock.execute).toHaveBeenCalledTimes(4);
    const hydrateStatement = sqlText(dbMock.execute.mock.calls[1]?.[0]);
    expect(hydrateStatement).toContain("SELECT content, debug_trace");
    expect(hydrateStatement).toContain("lease_turn.status = 'running'");
    expect(queryValues(dbMock.execute.mock.calls[2]?.[0])).toEqual(
      expect.arrayContaining([
        "Briefing delivered.",
        expect.stringContaining('"uiMessageParts":[{"type":"text","text":"Briefing delivered."'),
        expect.stringContaining('"aborted":true'),
      ]),
    );
    expect(queryValues(dbMock.execute.mock.calls[3]?.[0])).toContain("interrupted");
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
  return createProductChatProjector({
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
      canonicalAttemptId: "attempt_1",
      turnStartedAt: new Date("2026-07-30T10:00:00.000Z"),
    },
    execution: executionMock,
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
