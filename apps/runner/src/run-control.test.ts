import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendRuntimeEvent } from "./events";
import {
  claimRunLease,
  createRunControlGate,
  finishRunLease,
  heartbeatAndCheckRunControl,
  isStaleActiveRun,
  RunAbortError,
  type RunControlStore,
  RunLeaseLostError,
  type RunLeaseState,
  withRunControlChecks,
} from "./run-control";

// claimRunLease / finishRunLease emit their status events through
// events.appendRuntimeEvent (mocked so it never touches a database) after building
// the db arg via ./db's getDb (also mocked). The rest of the suite injects a store
// stub and never reaches these, so the module mocks are inert there.
const dbMocks = vi.hoisted(() => ({ getDb: vi.fn(() => ({})) }));
vi.mock("./db", () => ({ getDb: dbMocks.getDb }));
vi.mock("./events", () => ({ appendRuntimeEvent: vi.fn(async () => ({ id: 1 })) }));

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

describe("run lease status events", () => {
  beforeEach(() => {
    vi.mocked(appendRuntimeEvent).mockClear();
  });

  const claimInput = {
    sessionId: "ses_123",
    leaseId: "run_123",
    leaseOwner: "runner-a",
    messageId: "msg_1",
    modelProvider: "anthropic",
    modelName: "claude",
  };

  it("emits a session.status running event after a successful claim", async () => {
    const claimed = await claimRunLease(
      claimInput,
      store({ claimLease: vi.fn().mockResolvedValue(true) }),
    );

    expect(claimed).toBe(true);
    expect(appendRuntimeEvent).toHaveBeenCalledTimes(1);
    // Lease-guarded append (mirrors session-lifecycle.ts): carries the lease identity
    // so a lost lease yields null and the running event is silently skipped.
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "ses_123",
        leaseId: "run_123",
        leaseOwner: "runner-a",
        type: "session.status",
        payload: { status: "running" },
      }),
    );
  });

  it("does not emit a status event when the claim is rejected", async () => {
    const claimed = await claimRunLease(
      claimInput,
      store({ claimLease: vi.fn().mockResolvedValue(false) }),
    );

    expect(claimed).toBe(false);
    expect(appendRuntimeEvent).not.toHaveBeenCalled();
  });

  it("emits a terminal session.status event after a successful finish", async () => {
    const finished = await finishRunLease(
      { sessionId: "ses_123", leaseId: "run_123", leaseOwner: "runner-a", status: "completed" },
      store({ finishLease: vi.fn().mockResolvedValue(true) }),
    );

    expect(finished).toBe(true);
    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: "ses_123",
        type: "session.status",
        payload: { status: "completed" },
      }),
    );
  });

  it("carries the failure status through to the status event", async () => {
    await finishRunLease(
      { sessionId: "ses_123", leaseId: "run_123", leaseOwner: "runner-a", status: "failed" },
      store({ finishLease: vi.fn().mockResolvedValue(true) }),
    );

    expect(appendRuntimeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "session.status", payload: { status: "failed" } }),
    );
  });

  it("does not emit a status event when the finish is rejected (lease lost)", async () => {
    const finished = await finishRunLease(
      { sessionId: "ses_123", leaseId: "run_123", leaseOwner: "runner-a", status: "completed" },
      store({ finishLease: vi.fn().mockResolvedValue(false) }),
    );

    expect(finished).toBe(false);
    expect(appendRuntimeEvent).not.toHaveBeenCalled();
  });

  it("still resolves the claim when emitting the status event throws", async () => {
    // The status event is best-effort: a failed append must not abort an otherwise
    // successful lease claim.
    vi.mocked(appendRuntimeEvent).mockRejectedValueOnce(new Error("event store down"));

    await expect(
      claimRunLease(claimInput, store({ claimLease: vi.fn().mockResolvedValue(true) })),
    ).resolves.toBe(true);
  });

  it("still resolves the finish when emitting the status event throws", async () => {
    vi.mocked(appendRuntimeEvent).mockRejectedValueOnce(new Error("event store down"));

    await expect(
      finishRunLease(
        { sessionId: "ses_123", leaseId: "run_123", leaseOwner: "runner-a", status: "completed" },
        store({ finishLease: vi.fn().mockResolvedValue(true) }),
      ),
    ).resolves.toBe(true);
  });
});
