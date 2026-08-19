import type { PooledDbClient, PooledDbHandle } from "@opencompany/db/pool";
import { describe, expect, it, vi } from "vitest";
import { runPostgresQueueMaintenance } from "./postgres-queue-maintenance";

type Pool = PooledDbHandle["pool"];

describe("runPostgresQueueMaintenance", () => {
  it("prunes terminal history in bounded batches and reports table health", async () => {
    const batchCounts = new Map([
      ["DELETE FROM goat.run_events", [2, 1]],
      ["DELETE FROM goat.codex_chat_events", [2, 0]],
      ["DELETE FROM goat.task_events", [1]],
      ["DELETE FROM goat.codex_chat_turns", [2, 2]],
    ]);
    const client = fakeClient(async (query) => {
      if (query.includes("pg_try_advisory_lock")) return rows([{ acquired: true }]);
      if (query.includes("pg_advisory_unlock")) return rows([{ pg_advisory_unlock: true }]);
      if (query.includes("pg_stat_user_tables")) {
        return rows([
          {
            table: "codex_chat_turns",
            liveTuples: "900",
            deadTuples: "100",
            lastAutovacuum: "2026-08-19T00:00:00.000Z",
          },
        ]);
      }
      for (const [pattern, counts] of batchCounts) {
        if (query.includes(pattern)) return rows([{ deletedCount: counts.shift() ?? 0 }]);
      }
      throw new Error(`Unexpected query: ${query}`);
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    const result = await runPostgresQueueMaintenance({
      pool,
      now: new Date("2026-08-19T12:00:00.000Z"),
      batchSize: 2,
      maxBatchesPerTable: 2,
    });

    expect(result).toEqual({
      acquired: true,
      pruned: {
        run_events: 3,
        codex_chat_events: 2,
        task_events: 1,
        codex_chat_turns: 4,
      },
      tableStats: [
        {
          table: "codex_chat_turns",
          liveTuples: 900,
          deadTuples: 100,
          deadTupleRatio: 0.1,
          lastAutovacuum: new Date("2026-08-19T00:00:00.000Z"),
        },
      ],
    });
    expect(client.release).toHaveBeenCalledWith();

    const deleteCalls = client.query.mock.calls.filter(([query]) =>
      String(query).includes("DELETE FROM"),
    );
    expect(deleteCalls).toHaveLength(7);
    for (const [query, params] of deleteCalls) {
      expect(query).toContain("SKIP LOCKED");
      expect(params?.[1]).toBe(2);
    }
    const eventCutoff = deleteCalls[0]?.[1]?.[0] as Date;
    const turnCutoff = deleteCalls.at(-1)?.[1]?.[0] as Date;
    expect(eventCutoff.toISOString()).toBe("2026-07-20T12:00:00.000Z");
    expect(turnCutoff.toISOString()).toBe("2026-05-21T12:00:00.000Z");
    const taskEventDelete = deleteCalls.find(([query]) =>
      String(query).includes("DELETE FROM goat.task_events"),
    );
    expect(taskEventDelete?.[0]).toContain("task.session_id IS NOT NULL");
    const turnDelete = deleteCalls.find(([query]) =>
      String(query).includes("DELETE FROM goat.codex_chat_turns"),
    );
    expect(turnDelete?.[0]).toContain("NOT EXISTS");
  });

  it("does no work when another runner holds the maintenance lock", async () => {
    const client = fakeClient(async (query) => {
      if (query.includes("pg_try_advisory_lock")) return rows([{ acquired: false }]);
      throw new Error(`Unexpected query: ${query}`);
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(runPostgresQueueMaintenance({ pool })).resolves.toMatchObject({
      acquired: false,
    });
    expect(client.query).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith();
  });

  it("destroys the checked-out session after a maintenance failure", async () => {
    const client = fakeClient(async (query) => {
      if (query.includes("pg_try_advisory_lock")) return rows([{ acquired: true }]);
      throw new Error("delete failed");
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(runPostgresQueueMaintenance({ pool })).rejects.toThrow("delete failed");
    expect(client.release).toHaveBeenCalledWith(true);
  });
});

function fakeClient(execute: (query: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) {
  return {
    query: vi.fn(execute),
    release: vi.fn(),
  } as unknown as PooledDbClient & {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

function rows<Row>(values: Row[]) {
  return Promise.resolve({ rows: values });
}
