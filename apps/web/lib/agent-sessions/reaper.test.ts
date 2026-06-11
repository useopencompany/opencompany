import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendSessionStreamEvent } from "@/lib/agent-sessions/durable-streams";
import { ORPHANED_RUN_ERROR, reapOrphanedRunningSessions } from "./reaper";

const mocks = vi.hoisted(() => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@opencompany/observability", () => ({
  createLogger: vi.fn(() => mocks.logger),
}));

vi.mock("@/lib/agent-sessions/durable-streams", () => ({
  appendSessionStreamEvent: vi.fn().mockResolvedValue(undefined),
}));

const appendSessionStreamEventMock = vi.mocked(appendSessionStreamEvent);

type Captured = {
  sessionUpdateSet?: Record<string, unknown>;
  messageUpdateSet?: Record<string, unknown>;
  insertedEvents?: Array<Record<string, unknown>>;
};

// Hand-rolled drizzle stand-in (the repo has no live test DB; see sweeper.test.ts /
// agent-schedules/runner.test.ts for the same fakeDb convention). It models the
// exact call chain reapOrphanedRunningSessions issues, in order:
//   1. db.select().from().where().orderBy().limit()      -> candidates subquery (never awaited)
//   2. db.update().set().where().returning()             -> reaped session rows
//   3. db.update().set().where()                         -> settle orphaned messages (awaited)
//   4. db.insert().values()                              -> durable failure events (awaited)
function fakeDb(reapedIds: string[]) {
  const captured: Captured = {};
  let updateCount = 0;

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => ({ __subquery: true }) }),
        }),
      }),
    }),
    update: () => {
      updateCount += 1;
      const isSessionUpdate = updateCount === 1;
      return {
        set: (values: Record<string, unknown>) => ({
          where: (..._args: unknown[]) => {
            if (isSessionUpdate) {
              captured.sessionUpdateSet = values;
              return { returning: async () => reapedIds.map((id) => ({ id })) };
            }
            captured.messageUpdateSet = values;
            return Promise.resolve(undefined);
          },
        }),
      };
    },
    insert: () => ({
      values: async (rows: Array<Record<string, unknown>>) => {
        captured.insertedEvents = rows;
      },
    }),
  };

  return { db, captured };
}

describe("reapOrphanedRunningSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails orphaned sessions, settles their in-flight turn, and reconciles viewers", async () => {
    const { db, captured } = fakeDb(["ses_a", "ses_b"]);
    const now = new Date("2026-06-09T11:19:00.000Z");

    const result = await reapOrphanedRunningSessions({ db: db as never, now });

    expect(result).toEqual({ reaped: 2, sessionIds: ["ses_a", "ses_b"] });

    // Session flipped to a clean failed terminal state with the lease released.
    expect(captured.sessionUpdateSet).toMatchObject({
      status: "failed",
      runLeaseId: null,
      runLeaseOwner: null,
      runLeaseMessageId: null,
      runLeaseExpiresAt: null,
      runHeartbeatAt: null,
      lastError: ORPHANED_RUN_ERROR,
      updatedAt: now,
    });

    // Orphaned running assistant turn settled.
    expect(captured.messageUpdateSet).toEqual({ status: "failed", completedAt: now });

    // One durable failure event persisted per reaped session.
    expect(captured.insertedEvents).toEqual([
      { sessionId: "ses_a", type: "session.error", payload: { message: ORPHANED_RUN_ERROR } },
      { sessionId: "ses_b", type: "session.error", payload: { message: ORPHANED_RUN_ERROR } },
    ]);

    // Live viewers reconciled via the durable stream.
    expect(appendSessionStreamEventMock).toHaveBeenCalledTimes(2);
    expect(appendSessionStreamEventMock).toHaveBeenCalledWith("ses_a", {
      id: null,
      type: "session.error",
      messageId: null,
      payload: { message: ORPHANED_RUN_ERROR },
      createdAt: now.toISOString(),
    });
  });

  it("does nothing when no sessions are orphaned", async () => {
    const { db, captured } = fakeDb([]);

    const result = await reapOrphanedRunningSessions({ db: db as never, now: new Date() });

    expect(result).toEqual({ reaped: 0, sessionIds: [] });
    expect(captured.messageUpdateSet).toBeUndefined();
    expect(captured.insertedEvents).toBeUndefined();
    expect(appendSessionStreamEventMock).not.toHaveBeenCalled();
  });

  it("never lets a durable-stream failure abort the sweep", async () => {
    const { db } = fakeDb(["ses_a"]);
    appendSessionStreamEventMock.mockRejectedValueOnce(new Error("stream down"));

    const result = await reapOrphanedRunningSessions({ db: db as never, now: new Date() });

    expect(result).toEqual({ reaped: 1, sessionIds: ["ses_a"] });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "Failed to append reaper failure event to durable stream",
      expect.objectContaining({
        event: "opencompany.orphaned_run_reaper_stream_append_failed",
        session_id: "ses_a",
      }),
    );
  });
});
