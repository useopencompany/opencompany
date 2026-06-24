import { describe, expect, it, vi } from "vitest";
import {
  createRunControlGate,
  heartbeatAndCheckRunControl,
  isStaleActiveRun,
  RunAbortError,
  type RunControlStore,
  RunLeaseLostError,
  type RunLeaseState,
  shouldStampTurnFinished,
  withRunControlChecks,
} from "./run-control";

const lease = {
  sessionId: "ses_123",
  leaseId: "run_123",
  leaseOwner: "runner-a",
};

function state(overrides: Partial<RunLeaseState> = {}): RunLeaseState {
  return {
    status: "running",
    runLeaseId: lease.leaseId,
    runLeaseOwner: lease.leaseOwner,
    runLeaseExpiresAt: new Date(Date.now() + 60_000),
    runHeartbeatAt: new Date(),
    abortRequestedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function store(overrides: Partial<RunControlStore>): RunControlStore {
  return {
    claimLease: vi.fn(),
    heartbeatAndLoadState: vi.fn().mockResolvedValue(state()),
    finishLease: vi.fn(),
    releaseLease: vi.fn(),
    ...overrides,
  };
}

describe("run control", () => {
  it("aborts a local controller when DB state has an external abort request", async () => {
    const controller = new AbortController();
    const runStore = store({
      heartbeatAndLoadState: vi.fn().mockResolvedValue(state({ abortRequestedAt: new Date() })),
    });

    await expect(heartbeatAndCheckRunControl({ ...lease, controller }, runStore)).rejects.toThrow(
      RunAbortError,
    );
    expect(controller.signal.aborted).toBe(true);
  });

  it("refreshes the lease heartbeat and reads run control in a single round-trip", async () => {
    const controller = new AbortController();
    const heartbeatAndLoadState = vi.fn().mockResolvedValue(state());
    const runStore = store({ heartbeatAndLoadState });

    await heartbeatAndCheckRunControl({ ...lease, controller }, runStore);

    expect(heartbeatAndLoadState).toHaveBeenCalledTimes(1);
    expect(heartbeatAndLoadState).toHaveBeenCalledWith(
      expect.objectContaining(lease),
      expect.any(Date),
      expect.any(Date),
    );
    expect(controller.signal.aborted).toBe(false);
  });

  it("treats a missing row (reclaimed or archived lease) as lease loss", async () => {
    const controller = new AbortController();
    const runStore = store({ heartbeatAndLoadState: vi.fn().mockResolvedValue(null) });

    await expect(heartbeatAndCheckRunControl({ ...lease, controller }, runStore)).rejects.toThrow(
      RunLeaseLostError,
    );
    expect(controller.signal.aborted).toBe(true);
  });

  it("identifies stale active runs by old heartbeat timestamps", () => {
    expect(
      isStaleActiveRun(
        state({ runHeartbeatAt: new Date("2026-05-22T10:00:00.000Z") }),
        new Date("2026-05-22T10:06:00.000Z"),
      ),
    ).toBe(true);

    expect(
      isStaleActiveRun(
        state({ runHeartbeatAt: new Date("2026-05-22T10:04:00.000Z") }),
        new Date("2026-05-22T10:06:00.000Z"),
      ),
    ).toBe(false);
  });

  it("checks abort state before and after guarded work", async () => {
    const checkAbort = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new RunAbortError());
    const run = vi.fn().mockResolvedValue("done");

    await expect(withRunControlChecks(checkAbort, run)).rejects.toThrow(RunAbortError);

    expect(run).toHaveBeenCalledOnce();
    expect(checkAbort).toHaveBeenCalledTimes(2);
  });

  it("keeps checking abort state while quiet guarded work is pending", async () => {
    vi.useFakeTimers();
    const checkAbort = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("done"), 1_200);
        }),
    );

    const guarded = withRunControlChecks(checkAbort, run, { intervalMs: 500 });
    await Promise.resolve();

    expect(checkAbort).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(checkAbort).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(checkAbort).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(200);

    await expect(guarded).resolves.toBe("done");
    expect(checkAbort).toHaveBeenCalledTimes(4);
  });

  it("does not start guarded work when the first abort check fails", async () => {
    const checkAbort = vi.fn().mockRejectedValue(new RunAbortError());
    const run = vi.fn().mockResolvedValue("done");

    await expect(withRunControlChecks(checkAbort, run)).rejects.toThrow(RunAbortError);

    expect(run).not.toHaveBeenCalled();
    expect(checkAbort).toHaveBeenCalledOnce();
  });
});

describe("createRunControlGate", () => {
  function gateHarness(overrides: Partial<RunControlStore> = {}) {
    const controller = new AbortController();
    const heartbeatAndLoadState = vi.fn().mockResolvedValue(state());
    const runStore = store({ heartbeatAndLoadState, ...overrides });
    let clock = 0;
    const gate = createRunControlGate({
      runLease: lease,
      controller,
      store: runStore,
      intervalMs: 5_000,
      now: () => clock,
    });
    return {
      controller,
      heartbeatAndLoadState,
      gate,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("reads from the DB once per interval, not once per call", async () => {
    const { gate, heartbeatAndLoadState, advance } = gateHarness();

    // First call always reconciles, then 100 hot-path calls inside one interval.
    for (let i = 0; i < 100; i += 1) {
      await gate();
      advance(40); // ~40ms apart, like fast text-delta tokens
    }

    // 100 calls spanning ~4s stay within the 5s window after the initial read.
    expect(heartbeatAndLoadState).toHaveBeenCalledTimes(1);

    // Crossing the interval boundary triggers exactly one more read.
    advance(5_000);
    await gate();
    expect(heartbeatAndLoadState).toHaveBeenCalledTimes(2);
  });

  it("forces a DB read at a boundary regardless of the throttle", async () => {
    const { gate, heartbeatAndLoadState } = gateHarness();

    await gate(); // initial reconcile
    await gate({ force: true });
    await gate({ force: true });

    expect(heartbeatAndLoadState).toHaveBeenCalledTimes(3);
  });

  it("detects a remote abort flipped mid-stream within the throttle interval", async () => {
    const { gate, heartbeatAndLoadState, controller, advance } = gateHarness();

    await gate(); // healthy initial read
    expect(controller.signal.aborted).toBe(false);

    // Abort requested on another path after the run started streaming.
    heartbeatAndLoadState.mockResolvedValue(state({ abortRequestedAt: new Date() }));

    // Still inside the interval: hot-path calls skip the DB and do not yet see it.
    advance(2_000);
    await expect(gate()).resolves.toBeUndefined();
    expect(controller.signal.aborted).toBe(false);

    // Once the interval elapses the next hot-path call reconciles and aborts.
    advance(3_000);
    await expect(gate()).rejects.toThrow(RunAbortError);
    expect(controller.signal.aborted).toBe(true);
  });

  it("honors a local abort on the very next call without a DB read", async () => {
    const { gate, heartbeatAndLoadState, controller } = gateHarness();

    await gate(); // initial read
    expect(heartbeatAndLoadState).toHaveBeenCalledTimes(1);

    // Stop button / external signal aborts the local controller mid-interval.
    controller.abort();

    await expect(gate()).rejects.toThrow(RunAbortError);
    // No throttle wait, no extra DB round-trip — local abort is instant.
    expect(heartbeatAndLoadState).toHaveBeenCalledTimes(1);
  });
});

describe("shouldStampTurnFinished", () => {
  // This is the contract behind the sidebar's "unseen" blue dot: lastTurnFinishedAt may only
  // advance on a genuine yield back to the user. The bug this guards against — a background
  // after-session/memory-keeper pass re-arming the dot on a session the user already read —
  // is exactly the markTurnFinished:false case below.

  it("stamps on a normal user-facing turn completion", () => {
    expect(shouldStampTurnFinished({ status: "completed" })).toBe(true);
  });

  it("stamps when a turn fails or parks for approval/input (still a yield to the user)", () => {
    expect(shouldStampTurnFinished({ status: "failed" })).toBe(true);
    expect(shouldStampTurnFinished({ status: "awaiting_approval" })).toBe(true);
    expect(shouldStampTurnFinished({ status: "awaiting_input" })).toBe(true);
  });

  it("does NOT stamp on a user-initiated abort", () => {
    expect(shouldStampTurnFinished({ status: "aborting" })).toBe(false);
  });

  it("does NOT stamp an internal after-session run, regardless of status", () => {
    // The regression guard: a memory-keeper / after-session release must never advance the
    // marker, so it can't re-show the dot on a session the user has already read.
    expect(shouldStampTurnFinished({ status: "completed", markTurnFinished: false })).toBe(false);
    expect(shouldStampTurnFinished({ status: "failed", markTurnFinished: false })).toBe(false);
  });

  it("treats an explicit markTurnFinished:true like the default (stamps)", () => {
    expect(shouldStampTurnFinished({ status: "completed", markTurnFinished: true })).toBe(true);
  });
});
