import { captureException } from "@opencompany/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_FILE_SYNC_REQUESTED_EVENT,
  AGENT_SYNC_REQUESTED_EVENT,
} from "@/lib/agents/sync-events";
import { BRAIN_SYNC_REQUESTED_EVENT } from "@/lib/brain/sync-events";
import {
  filterDueAgentFileSyncJobs,
  filterDueAgentSyncJobs,
  filterDueBrainSyncJobs,
  nextSyncRetryAt,
  sweepAgentFileSyncOutbox,
  sweepAgentSyncOutbox,
  sweepBrainSyncOutbox,
} from "./sweeper";

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

describe("sync outbox due-job filtering", () => {
  const now = new Date("2026-05-27T12:00:00.000Z");

  it("selects due pending and failed agent jobs in next-run order", () => {
    expect(
      filterDueAgentSyncJobs(
        [
          {
            agentId: "agt_future",
            workspaceId: "wks_123",
            status: "pending",
            attempts: 0,
            nextRunAt: new Date("2026-05-27T12:00:01.000Z"),
          },
          {
            agentId: "agt_syncing",
            workspaceId: "wks_123",
            status: "syncing",
            attempts: 0,
            nextRunAt: new Date("2026-05-27T11:59:00.000Z"),
          },
          {
            agentId: "agt_failed",
            workspaceId: "wks_123",
            status: "failed",
            attempts: 1,
            nextRunAt: new Date("2026-05-27T11:58:00.000Z"),
          },
          {
            agentId: "agt_exhausted",
            workspaceId: "wks_123",
            status: "failed",
            attempts: 5,
            nextRunAt: new Date("2026-05-27T11:57:30.000Z"),
          },
          {
            agentId: "agt_pending",
            workspaceId: "wks_123",
            status: "pending",
            attempts: 0,
            nextRunAt: now,
          },
          {
            agentId: "agt_unknown",
            workspaceId: "wks_123",
            status: "paused",
            attempts: 0,
            nextRunAt: new Date("2026-05-27T11:57:00.000Z"),
          },
        ],
        { now },
      ),
    ).toEqual([
      { agentId: "agt_failed", workspaceId: "wks_123" },
      { agentId: "agt_pending", workspaceId: "wks_123" },
    ]);
  });

  it("selects due pending and failed brain jobs and honors the sweep limit", () => {
    expect(
      filterDueBrainSyncJobs(
        [
          {
            workspaceId: "wks_123",
            path: "future.md",
            status: "failed",
            attempts: 1,
            nextRunAt: new Date("2026-05-27T12:00:01.000Z"),
          },
          {
            workspaceId: "wks_123",
            path: "syncing.md",
            status: "syncing",
            attempts: 0,
            nextRunAt: new Date("2026-05-27T11:56:00.000Z"),
          },
          {
            workspaceId: "wks_123",
            path: "a.md",
            status: "pending",
            attempts: 0,
            nextRunAt: new Date("2026-05-27T11:57:00.000Z"),
          },
          {
            workspaceId: "wks_123",
            path: "b.md",
            status: "failed",
            attempts: 1,
            nextRunAt: new Date("2026-05-27T11:58:00.000Z"),
          },
        ],
        { now, limit: 1 },
      ),
    ).toEqual([{ workspaceId: "wks_123", path: "a.md" }]);
  });

  it("selects due pending and failed agent file jobs", () => {
    expect(
      filterDueAgentFileSyncJobs(
        [
          {
            workspaceId: "wks_123",
            path: "agents/sales/future.md",
            status: "pending",
            attempts: 0,
            nextRunAt: new Date("2026-05-27T12:00:01.000Z"),
          },
          {
            workspaceId: "wks_123",
            path: "agents/sales/syncing.md",
            status: "syncing",
            attempts: 0,
            nextRunAt: new Date("2026-05-27T11:59:00.000Z"),
          },
          {
            workspaceId: "wks_123",
            path: "agents/sales/memory.md",
            status: "failed",
            attempts: 1,
            nextRunAt: new Date("2026-05-27T11:58:00.000Z"),
          },
        ],
        { now },
      ),
    ).toEqual([{ workspaceId: "wks_123", path: "agents/sales/memory.md" }]);
  });

  it("backs off failed sync retries exponentially with a cap", () => {
    expect(nextSyncRetryAt(now, 1)).toEqual(new Date("2026-05-27T12:01:00.000Z"));
    expect(nextSyncRetryAt(now, 3)).toEqual(new Date("2026-05-27T12:04:00.000Z"));
    expect(nextSyncRetryAt(now, 10)).toEqual(new Date("2026-05-27T12:30:00.000Z"));
  });
});

describe("sync outbox sweepers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches one agent sync event for each due job", async () => {
    const step = createStepMock();

    await expect(
      sweepAgentSyncOutbox(step, {
        loadDueDispatches: async () => [
          { agentId: "agt_1", workspaceId: "wks_123" },
          { agentId: "agt_2", workspaceId: "wks_123" },
        ],
      }),
    ).resolves.toEqual({ dispatched: 2 });

    expect(step.run).toHaveBeenCalledWith("load due agent sync jobs", expect.any(Function));
    expect(step.sendEvent).toHaveBeenCalledWith("dispatch agent sync requests", [
      {
        name: AGENT_SYNC_REQUESTED_EVENT,
        data: { agentId: "agt_1", workspaceId: "wks_123" },
      },
      {
        name: AGENT_SYNC_REQUESTED_EVENT,
        data: { agentId: "agt_2", workspaceId: "wks_123" },
      },
    ]);
    expect(mocks.logger.warn).toHaveBeenCalledWith("Dispatched sync outbox recovery events", {
      event: "opencompany.sync_outbox_recovery_dispatched",
      resource_type: "agent",
      dispatched_count: 2,
    });
  });

  it("dispatches one brain sync event for each due job", async () => {
    const step = createStepMock();

    await expect(
      sweepBrainSyncOutbox(step, {
        loadDueDispatches: async () => [
          { workspaceId: "wks_123", path: "docs/a.md" },
          { workspaceId: "wks_123", path: "docs/b.md" },
        ],
      }),
    ).resolves.toEqual({ dispatched: 2 });

    expect(step.run).toHaveBeenCalledWith("load due brain sync jobs", expect.any(Function));
    expect(step.sendEvent).toHaveBeenCalledWith("dispatch brain sync requests", [
      {
        name: BRAIN_SYNC_REQUESTED_EVENT,
        data: { workspaceId: "wks_123", path: "docs/a.md" },
      },
      {
        name: BRAIN_SYNC_REQUESTED_EVENT,
        data: { workspaceId: "wks_123", path: "docs/b.md" },
      },
    ]);
    expect(mocks.logger.warn).toHaveBeenCalledWith("Dispatched sync outbox recovery events", {
      event: "opencompany.sync_outbox_recovery_dispatched",
      resource_type: "brain",
      dispatched_count: 2,
    });
  });

  it("dispatches one agent file sync event for each due job", async () => {
    const step = createStepMock();

    await expect(
      sweepAgentFileSyncOutbox(step, {
        loadDueDispatches: async () => [
          { workspaceId: "wks_123", path: "agents/sales/memory.md" },
          { workspaceId: "wks_123", path: "agents/sales/sessions.md" },
        ],
      }),
    ).resolves.toEqual({ dispatched: 2 });

    expect(step.run).toHaveBeenCalledWith("load due agent file sync jobs", expect.any(Function));
    expect(step.sendEvent).toHaveBeenCalledWith("dispatch agent file sync requests", [
      {
        name: AGENT_FILE_SYNC_REQUESTED_EVENT,
        data: { workspaceId: "wks_123", path: "agents/sales/memory.md" },
      },
      {
        name: AGENT_FILE_SYNC_REQUESTED_EVENT,
        data: { workspaceId: "wks_123", path: "agents/sales/sessions.md" },
      },
    ]);
    expect(mocks.logger.warn).toHaveBeenCalledWith("Dispatched sync outbox recovery events", {
      event: "opencompany.sync_outbox_recovery_dispatched",
      resource_type: "agent_file",
      dispatched_count: 2,
    });
  });

  it("does not dispatch when no sync jobs are due", async () => {
    const step = createStepMock();

    await expect(
      sweepAgentSyncOutbox(step, {
        loadDueDispatches: async () => [],
      }),
    ).resolves.toEqual({ dispatched: 0 });

    expect(step.sendEvent).not.toHaveBeenCalled();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("captures and rethrows agent recovery dispatch failures", async () => {
    const step = createStepMock();
    const error = new Error("Inngest unavailable");
    step.sendEvent.mockRejectedValue(error);

    await expect(
      sweepAgentSyncOutbox(step, {
        loadDueDispatches: async () => [{ agentId: "agt_1", workspaceId: "wks_123" }],
      }),
    ).rejects.toThrow(error);

    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      event: "opencompany.sync_outbox_recovery_dispatch_failed",
      resource_type: "agent",
      dispatched_count: 1,
    });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "Failed to dispatch sync outbox recovery events",
      {
        event: "opencompany.sync_outbox_recovery_dispatch_failed",
        resource_type: "agent",
        dispatched_count: 1,
        error_name: "Error",
        error_message: "Inngest unavailable",
      },
    );
  });

  it("captures and rethrows brain recovery dispatch failures", async () => {
    const step = createStepMock();
    const error = new Error("Inngest unavailable");
    step.sendEvent.mockRejectedValue(error);

    await expect(
      sweepBrainSyncOutbox(step, {
        loadDueDispatches: async () => [{ workspaceId: "wks_123", path: "docs/a.md" }],
      }),
    ).rejects.toThrow(error);

    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      event: "opencompany.sync_outbox_recovery_dispatch_failed",
      resource_type: "brain",
      dispatched_count: 1,
    });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "Failed to dispatch sync outbox recovery events",
      {
        event: "opencompany.sync_outbox_recovery_dispatch_failed",
        resource_type: "brain",
        dispatched_count: 1,
        error_name: "Error",
        error_message: "Inngest unavailable",
      },
    );
  });
});
