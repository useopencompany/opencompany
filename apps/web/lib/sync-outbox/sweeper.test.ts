import { captureException } from "@opencompany/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_SYNC_REQUESTED_EVENT } from "@/lib/workspace-sync/events";
import { filterDueWorkspaceSyncJobs, nextSyncRetryAt, sweepWorkspaceSyncOutbox } from "./sweeper";

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

describe("workspace sync outbox due-job filtering", () => {
  const now = new Date("2026-05-27T12:00:00.000Z");

  it("selects due pending and failed workspace jobs in next-run order and honors the limit", () => {
    expect(
      filterDueWorkspaceSyncJobs(
        [
          {
            workspaceId: "wks_future",
            status: "failed",
            attempts: 1,
            nextRunAt: new Date("2026-05-27T12:00:01.000Z"),
          },
          {
            workspaceId: "wks_syncing",
            status: "syncing",
            attempts: 0,
            nextRunAt: new Date("2026-05-27T11:56:00.000Z"),
          },
          {
            workspaceId: "wks_exhausted",
            status: "failed",
            attempts: 5,
            nextRunAt: new Date("2026-05-27T11:55:00.000Z"),
          },
          {
            workspaceId: "wks_a",
            status: "pending",
            attempts: 0,
            nextRunAt: new Date("2026-05-27T11:57:00.000Z"),
          },
          {
            workspaceId: "wks_b",
            status: "failed",
            attempts: 1,
            nextRunAt: new Date("2026-05-27T11:58:00.000Z"),
          },
        ],
        { now },
      ),
    ).toEqual([{ workspaceId: "wks_a" }, { workspaceId: "wks_b" }]);
  });

  it("backs off failed sync retries exponentially with a cap", () => {
    expect(nextSyncRetryAt(now, 1)).toEqual(new Date("2026-05-27T12:01:00.000Z"));
    expect(nextSyncRetryAt(now, 3)).toEqual(new Date("2026-05-27T12:04:00.000Z"));
    expect(nextSyncRetryAt(now, 10)).toEqual(new Date("2026-05-27T12:30:00.000Z"));
  });
});

describe("workspace sync outbox sweeper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches one workspace sync event for each due job", async () => {
    const step = createStepMock();

    await expect(
      sweepWorkspaceSyncOutbox(step, {
        loadDueDispatches: async () => [{ workspaceId: "wks_1" }, { workspaceId: "wks_2" }],
      }),
    ).resolves.toEqual({ dispatched: 2 });

    expect(step.run).toHaveBeenCalledWith("load due workspace sync jobs", expect.any(Function));
    expect(step.sendEvent).toHaveBeenCalledWith("dispatch workspace sync requests", [
      {
        name: WORKSPACE_SYNC_REQUESTED_EVENT,
        data: { workspaceId: "wks_1" },
      },
      {
        name: WORKSPACE_SYNC_REQUESTED_EVENT,
        data: { workspaceId: "wks_2" },
      },
    ]);
    expect(mocks.logger.warn).toHaveBeenCalledWith("Dispatched sync outbox recovery events", {
      event: "opencompany.sync_outbox_recovery_dispatched",
      resource_type: "workspace",
      dispatched_count: 2,
    });
  });

  it("does not dispatch when no sync jobs are due", async () => {
    const step = createStepMock();

    await expect(
      sweepWorkspaceSyncOutbox(step, {
        loadDueDispatches: async () => [],
      }),
    ).resolves.toEqual({ dispatched: 0 });

    expect(step.sendEvent).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("captures and rethrows workspace recovery dispatch failures", async () => {
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
