import { afterEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
const recallMocks = vi.hoisted(() => ({ recallSessions: vi.fn(async () => []) }));

vi.mock("./db", () => ({ getDb: dbMocks.getDb }));
vi.mock("@opencompany/db/recall", () => ({ recallSessions: recallMocks.recallSessions }));

import { runRecallTool } from "./recall-tool";

afterEach(() => {
  vi.clearAllMocks();
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
});
