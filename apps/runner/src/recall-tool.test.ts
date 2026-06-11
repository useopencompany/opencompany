import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
const recallMocks = vi.hoisted(() => ({ recallSessions: vi.fn(async () => []) }));

vi.mock("./db", () => ({ getDb: dbMocks.getDb }));
vi.mock("@opencompany/db/recall", () => ({ recallSessions: recallMocks.recallSessions }));

import { runRecallTool } from "./recall-tool";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("runRecallTool", () => {
  it("sets the recall timeout with a transaction-local set_config call", async () => {
    const executedQueries: unknown[] = [];
    const execute = vi.fn(async (query: unknown) => {
      executedQueries.push(query);
    });
    const tx = { execute };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ agentId: "agent_1", userId: "user_1" }],
          }),
        }),
      }),
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };
    dbMocks.getDb.mockReturnValue(db);

    const result = await runRecallTool({
      sessionId: "session_live",
      args: { query: "harness setup feedback integrations", limit: 3 },
    });

    expect(result).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledOnce();

    const timeoutQuery = executedQueries[0] as
      | { queryChunks?: Array<string | { value?: string[] }> }
      | undefined;
    const sqlText =
      timeoutQuery?.queryChunks
        ?.map((chunk) => (typeof chunk === "string" ? "?" : (chunk.value ?? []).join("")))
        .join("") ?? "";
    const params = timeoutQuery?.queryChunks?.filter((chunk) => typeof chunk === "string") ?? [];

    expect(sqlText).toBe("SELECT set_config('statement_timeout', ?, true)");
    expect(params).toEqual(["5000ms"]);
    expect(recallMocks.recallSessions).toHaveBeenCalledWith(tx, {
      agentId: "agent_1",
      userId: "user_1",
      excludeSessionId: "session_live",
      query: "harness setup feedback integrations",
      limit: 3,
    });
  });

  it("passes a createdAfter cutoff when query and time_window are provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T12:00:00.000Z"));
    const tx = { execute: vi.fn(async () => {}) };
    dbMocks.getDb.mockReturnValue(mockDb(tx));

    const result = await runRecallTool({
      sessionId: "session_live",
      args: {
        query: "launch date",
        time_window: { amount: 6, unit: "hours" },
        limit: 4,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      query: "launch date",
      timeWindow: {
        amount: 6,
        unit: "hours",
        createdAfter: "2026-06-11T06:00:00.000Z",
      },
    });
    expect(recallMocks.recallSessions).toHaveBeenCalledWith(tx, {
      agentId: "agent_1",
      userId: "user_1",
      excludeSessionId: "session_live",
      query: "launch date",
      limit: 4,
      createdAfter: new Date("2026-06-11T06:00:00.000Z"),
    });
  });

  it("accepts time_window without a query for recent session recall", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T12:00:00.000Z"));
    const tx = { execute: vi.fn(async () => {}) };
    dbMocks.getDb.mockReturnValue(mockDb(tx));

    const result = await runRecallTool({
      sessionId: "session_live",
      args: { time_window: { amount: 2, unit: "days" } },
    });

    expect(result).toMatchObject({
      ok: true,
      query: "",
      timeWindow: {
        amount: 2,
        unit: "days",
        createdAfter: "2026-06-09T12:00:00.000Z",
      },
    });
    expect(recallMocks.recallSessions).toHaveBeenCalledWith(tx, {
      agentId: "agent_1",
      userId: "user_1",
      excludeSessionId: "session_live",
      query: "",
      createdAfter: new Date("2026-06-09T12:00:00.000Z"),
    });
  });

  it("rejects input with neither query nor time_window", async () => {
    const result = await runRecallTool({
      sessionId: "session_live",
      args: { limit: 3 },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        message: "recall requires either a non-empty `query` or `time_window`.",
        code: "invalid_tool_input",
        recoverable: true,
      },
    });
    expect(dbMocks.getDb).not.toHaveBeenCalled();
    expect(recallMocks.recallSessions).not.toHaveBeenCalled();
  });

  it("rejects unsupported time_window units and non-positive amounts", async () => {
    const invalidUnit = await runRecallTool({
      sessionId: "session_live",
      args: { time_window: { amount: 1, unit: "weeks" } },
    });
    const invalidAmount = await runRecallTool({
      sessionId: "session_live",
      args: { time_window: { amount: 0, unit: "hours" } },
    });

    expect(invalidUnit).toMatchObject({
      ok: false,
      error: {
        code: "invalid_tool_input",
        message: '`time_window.unit` must be either "hours" or "days".',
      },
    });
    expect(invalidAmount).toMatchObject({
      ok: false,
      error: {
        code: "invalid_tool_input",
        message: "`time_window.amount` must be greater than 0.",
      },
    });
    expect(dbMocks.getDb).not.toHaveBeenCalled();
    expect(recallMocks.recallSessions).not.toHaveBeenCalled();
  });
});

function mockDb(tx: unknown) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ agentId: "agent_1", userId: "user_1" }],
        }),
      }),
    }),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
  };
}
