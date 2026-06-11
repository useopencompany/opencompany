import { afterEach, describe, expect, it, vi } from "vitest";
import { clearActiveRun, setActiveRun } from "./active-runs";
import { interruptActiveRuns, interruptStaleActiveRuns } from "./session-interruptions";

const { dbRef, publishRuntimeEvent } = vi.hoisted(() => ({
  dbRef: { current: {} as unknown },
  publishRuntimeEvent: vi.fn(),
}));

vi.mock("./db", () => ({
  getDb: () => dbRef.current,
}));

vi.mock("./events", () => ({
  publishRuntimeEvent,
}));

afterEach(() => {
  publishRuntimeEvent.mockReset();
});

describe("session interruption cleanup", () => {
  it("interrupts stale running sessions and publishes status plus audit events", async () => {
    const execute = vi.fn(async () => ({
      rows: [
        {
          sessionId: "ses_stale",
          leaseId: "run_stale",
          leaseOwner: "runner-old",
        },
        {
          sessionId: "ses_stale_2",
          leaseId: "run_stale_2",
          leaseOwner: "runner-old",
        },
      ],
    }));
    const insert = vi.fn(() => ({
      values: (
        values: Array<{ sessionId: string; type: string; payload: Record<string, unknown> }>,
      ) => ({
        returning: async () =>
          values.map((value, index) => ({
            id: index + 1,
            sessionId: value.sessionId,
            messageId: null,
            type: value.type,
            payload: value.payload,
            createdAt: new Date("2026-06-09T12:00:00.000Z"),
          })),
      }),
    }));
    dbRef.current = {
      transaction: async (
        callback: (tx: { execute: typeof execute; insert: typeof insert }) => unknown,
      ) => callback({ execute, insert }),
    };

    const count = await interruptStaleActiveRuns(new Date("2026-06-09T12:10:00.000Z"));

    expect(count).toBe(2);
    expect(execute).toHaveBeenCalledOnce();
    // All sessions' events land in a single batched insert inside the transaction.
    expect(insert).toHaveBeenCalledOnce();
    expect(publishRuntimeEvent).toHaveBeenCalledTimes(4);
    expect(publishRuntimeEvent).toHaveBeenNthCalledWith(
      1,
      "ses_stale",
      expect.objectContaining({
        sessionId: "ses_stale",
        type: "session.status",
        payload: { status: "interrupted" },
      }),
    );
    expect(publishRuntimeEvent).toHaveBeenNthCalledWith(
      2,
      "ses_stale",
      expect.objectContaining({
        sessionId: "ses_stale",
        type: "session.interrupted",
        payload: {
          reason: "stale_heartbeat",
          leaseId: "run_stale",
          leaseOwner: "runner-old",
        },
      }),
    );
    expect(publishRuntimeEvent).toHaveBeenNthCalledWith(
      3,
      "ses_stale_2",
      expect.objectContaining({
        sessionId: "ses_stale_2",
        type: "session.status",
        payload: { status: "interrupted" },
      }),
    );
    expect(publishRuntimeEvent).toHaveBeenNthCalledWith(
      4,
      "ses_stale_2",
      expect.objectContaining({
        sessionId: "ses_stale_2",
        type: "session.interrupted",
        payload: {
          reason: "stale_heartbeat",
          leaseId: "run_stale_2",
          leaseOwner: "runner-old",
        },
      }),
    );
  });

  it("aborts local active runs even when the interruption write fails", async () => {
    const controller = new AbortController();
    setActiveRun("ses_active", "run_active", "runner-a", controller);
    dbRef.current = {
      execute: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    };

    try {
      const count = await interruptActiveRuns("runner_shutdown");

      expect(count).toBe(0);
      expect(controller.signal.aborted).toBe(true);
      expect(publishRuntimeEvent).not.toHaveBeenCalled();
    } finally {
      clearActiveRun("ses_active", controller);
    }
  });
});
