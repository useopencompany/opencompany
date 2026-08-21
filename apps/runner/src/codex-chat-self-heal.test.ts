import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FastFailingCodexChatSession,
  listFastFailingCodexChatSessions,
  selfHealCodexChatSession,
  sweepFastFailingCodexChatSessions,
} from "./codex-chat-self-heal";

const database = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("./db", () => ({ getDb: () => database }));

function lastQuery() {
  const calls = database.execute.mock.calls;
  return new PgDialect().sqlToQuery(calls[calls.length - 1]?.[0] as SQL).sql;
}

describe("listFastFailingCodexChatSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.execute.mockResolvedValue({ rows: [] });
  });

  it("selects settled sessions whose last K turns all fast-failed with no engine events", async () => {
    await listFastFailingCodexChatSessions({
      now: new Date("2026-08-21T12:00:00.000Z"),
      lookbackTurns: 3,
      maxFastFailMs: 30_000,
    });

    const query = lastQuery();
    expect(query).toContain("status IN ('idle', 'failed', 'interrupted')");
    expect(query).toContain(
      "session.sandbox_id IS NOT NULL OR session.codex_thread_id IS NOT NULL",
    );
    expect(query).toContain("recent.status = 'failed'");
    expect(query).toContain("recent.codex_turn_id IS NULL");
    expect(query).toContain("make_interval(secs =>");
    expect(query).toContain("stats.fast_fail_count =");
    expect(query).toContain("active.status IN ('queued', 'running')");
  });

  it("maps rows to typed sessions", async () => {
    database.execute.mockResolvedValueOnce({
      rows: [{ id: "s1", sandboxId: "sb1", codexThreadId: "t1" }],
    });

    const rows = await listFastFailingCodexChatSessions();

    expect(rows).toEqual([{ id: "s1", sandboxId: "sb1", codexThreadId: "t1" }]);
  });
});

describe("selfHealCodexChatSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears only the thread id when the session still holds one", async () => {
    database.execute.mockResolvedValue({ rows: [{ id: "s1" }] });
    const session: FastFailingCodexChatSession = {
      id: "s1",
      sandboxId: "sb1",
      codexThreadId: "t1",
    };

    const tier = await selfHealCodexChatSession(session, new Date("2026-08-21T12:00:00.000Z"));

    expect(tier).toBe("thread");
    const query = lastQuery();
    expect(query).toContain("codex_thread_id = NULL");
    expect(query).not.toContain("sandbox_id = NULL");
    expect(query).toContain("codex_thread_id IS NOT NULL");
    expect(query).toContain("active.status IN ('queued', 'running')");
  });

  it("clears the sandbox id once the thread is already null and the loop persists", async () => {
    database.execute.mockResolvedValue({ rows: [{ id: "s1" }] });
    const session: FastFailingCodexChatSession = {
      id: "s1",
      sandboxId: "sb1",
      codexThreadId: null,
    };

    const tier = await selfHealCodexChatSession(session);

    expect(tier).toBe("sandbox");
    const query = lastQuery();
    expect(query).toContain("sandbox_id = NULL");
    expect(query).toContain("codex_thread_id IS NULL AND sandbox_id IS NOT NULL");
  });

  it("is a no-op when a turn started in the meantime", async () => {
    database.execute.mockResolvedValue({ rows: [] });

    const tier = await selfHealCodexChatSession({
      id: "s1",
      sandboxId: "sb1",
      codexThreadId: "t1",
    });

    expect(tier).toBeNull();
  });
});

describe("sweepFastFailingCodexChatSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("heals each detected session and tallies the tiers applied", async () => {
    database.execute
      .mockResolvedValueOnce({
        rows: [
          { id: "s1", sandboxId: "sb1", codexThreadId: "t1" },
          { id: "s2", sandboxId: "sb2", codexThreadId: null },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "s1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "s2" }] });

    const result = await sweepFastFailingCodexChatSessions({
      now: new Date("2026-08-21T12:00:00.000Z"),
    });

    expect(result).toEqual({ detected: 2, threadResets: 1, sandboxResets: 1 });
  });
});
