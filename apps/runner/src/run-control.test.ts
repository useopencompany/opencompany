import { describe, expect, it, vi } from "vitest";
import {
  checkRunControl,
  isStaleActiveRun,
  maybeHeartbeatRunLease,
  RunAbortError,
  type RunControlStore,
  type RunLeaseState,
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
    heartbeat: vi.fn(),
    loadState: vi.fn(),
    finishLease: vi.fn(),
    releaseLease: vi.fn(),
    ...overrides,
  };
}

describe("run control", () => {
  it("aborts a local controller when DB state has an external abort request", async () => {
    const controller = new AbortController();
    const runStore = store({
      loadState: vi.fn().mockResolvedValue(state({ abortRequestedAt: new Date() })),
    });

    await expect(checkRunControl({ ...lease, controller }, runStore)).rejects.toThrow(
      RunAbortError,
    );
    expect(controller.signal.aborted).toBe(true);
  });

  it("writes heartbeats with the current lease id and owner", async () => {
    const heartbeat = vi.fn().mockResolvedValue(true);
    const runStore = store({ heartbeat });

    await expect(
      maybeHeartbeatRunLease({ ...lease, lastHeartbeatAt: 0 }, runStore),
    ).resolves.toMatchObject({ leaseActive: true });

    expect(heartbeat).toHaveBeenCalledWith(
      expect.objectContaining(lease),
      expect.any(Date),
      expect.any(Date),
    );
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
