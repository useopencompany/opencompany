import { captureException } from "@opencompany/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_SYNC_REQUESTED_EVENT } from "@/lib/workspace-state/sync-events";
import { nextSyncRetryAt, sweepWorkspaceSyncOutbox } from "./sweeper";

const mocks = vi.hoisted(() => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => mocks.logger),
}));

const captureExceptionMock = vi.mocked(captureException);

function createStepMock() {
  return {
    run: vi.fn(async (_id: string, handler: () => unknown) => handler()),
    sendEvent: vi.fn(async () => ({ ids: ["evt_123"] })),
  };
}

describe("nextSyncRetryAt", () => {
  it("backs off exponentially and caps", () => {
    const now = new Date("2026-05-27T12:00:00.000Z");
    expect(nextSyncRetryAt(now, 1).getTime()).toBe(now.getTime() + 60_000);
    expect(nextSyncRetryAt(now, 2).getTime()).toBe(now.getTime() + 120_000);
    // Capped at 30 minutes.
    expect(nextSyncRetryAt(now, 99).getTime()).toBe(now.getTime() + 30 * 60_000);
  });
});

describe("sweepWorkspaceSyncOutbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches one workspace sync event per due workspace", async () => {
    const step = createStepMock();

    const result = await sweepWorkspaceSyncOutbox(step, {
      loadDueDispatches: async () => [{ workspaceId: "wks_1" }, { workspaceId: "wks_2" }],
    });

    expect(result).toEqual({ dispatched: 2 });
    expect(step.sendEvent).toHaveBeenCalledWith("dispatch workspace sync requests", [
      { name: WORKSPACE_SYNC_REQUESTED_EVENT, data: { workspaceId: "wks_1" } },
      { name: WORKSPACE_SYNC_REQUESTED_EVENT, data: { workspaceId: "wks_2" } },
    ]);
  });

  it("does nothing when no workspace sync jobs are due", async () => {
    const step = createStepMock();
    const result = await sweepWorkspaceSyncOutbox(step, { loadDueDispatches: async () => [] });
    expect(result).toEqual({ dispatched: 0 });
    expect(step.sendEvent).not.toHaveBeenCalled();
  });

  it("captures and rethrows recovery dispatch failures", async () => {
    const step = createStepMock();
    const error = new Error("Inngest unavailable");
    step.sendEvent.mockRejectedValue(error);

    await expect(
      sweepWorkspaceSyncOutbox(step, {
        loadDueDispatches: async () => [{ workspaceId: "wks_1" }],
      }),
    ).rejects.toThrow(error);

    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      event: "opencompany.sync_outbox_recovery_dispatch_failed",
      resource_type: "workspace",
      dispatched_count: 1,
    });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "Failed to dispatch sync outbox recovery events",
      {
        event: "opencompany.sync_outbox_recovery_dispatch_failed",
        resource_type: "workspace",
        dispatched_count: 1,
        error_name: "Error",
        error_message: "Inngest unavailable",
      },
    );
  });
});
