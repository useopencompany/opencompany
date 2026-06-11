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
    const createdAt = new Date("2026-06-09T12:00:00.000Z");
    const execute = vi.fn(async () => ({
      rows: [
        {
          id: 1,
          sessionId: "ses_stale",
          messageId: null,
          type: "session.status",
          payload: { status: "interrupted" },
          createdAt,
        },
        {
          id: 2,
          sessionId: "ses_stale",
          messageId: null,
          type: "session.interrupted",
          payload: {
            reason: "stale_heartbeat",
            leaseId: "run_stale",
            leaseOwner: "runner-old",
          },
          createdAt,
        },
        {
          id: 3,
          sessionId: "ses_stale_2",
          messageId: null,
          type: "session.status",
          payload: { status: "interrupted" },
          createdAt,
        },
        {
          id: 4,
          sessionId: "ses_stale_2",
          messageId: null,
          type: "session.interrupted",
          payload: {
            reason: "stale_heartbeat",
            leaseId: "run_stale_2",
            leaseOwner: "runner-old",
          },
          createdAt,
        },
      ],
    }));
    dbRef.current = {
      execute,
    };

    const count = await interruptStaleActiveRuns(new Date("2026-06-09T12:10:00.000Z"));

    expect(count).toBe(2);
    expect(execute).toHaveBeenCalledOnce();
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
