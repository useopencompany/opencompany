import { captureException } from "@opencompany/observability";
import { after } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleBrainSyncDispatch } from "@/lib/brain/sync-dispatch";
import { dispatchBrainSyncRequested } from "@/lib/brain/sync-events";

const mocks = vi.hoisted(() => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
  createLogger: vi.fn(() => mocks.logger),
}));

vi.mock("next/server", () => ({
  after: vi.fn(),
}));

vi.mock("@/lib/brain/sync-events", () => ({
  dispatchBrainSyncRequested: vi.fn(),
}));

const afterMock = vi.mocked(after);
const captureExceptionMock = vi.mocked(captureException);
const dispatchBrainSyncRequestedMock = vi.mocked(dispatchBrainSyncRequested);

describe("Brain sync dispatch scheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs Inngest event ids when dispatch succeeds", async () => {
    dispatchBrainSyncRequestedMock.mockResolvedValue({ ids: ["evt_123"] });

    scheduleBrainSyncDispatch({
      workspaceId: "wks_123",
      path: "docs/a.md",
    });

    const callback = afterMock.mock.calls[0]?.[0];
    expect(callback).toBeTypeOf("function");
    await callback?.();

    expect(dispatchBrainSyncRequestedMock).toHaveBeenCalledWith({
      workspaceId: "wks_123",
      path: "docs/a.md",
    });
    expect(mocks.logger.info).toHaveBeenCalledWith("Dispatched Brain GitHub sync event", {
      event: "opencompany.brain_sync_dispatch_succeeded",
      workspace_id: "wks_123",
      path: "docs/a.md",
      inngest_event_ids: ["evt_123"],
    });
  });

  it("captures and logs dispatch failures without changing sync status", async () => {
    const error = new Error("Inngest API Error: 401 Event key not found");
    dispatchBrainSyncRequestedMock.mockRejectedValue(error);

    scheduleBrainSyncDispatch({
      workspaceId: "wks_123",
      path: "docs/a.md",
    });

    const callback = afterMock.mock.calls[0]?.[0];
    expect(callback).toBeTypeOf("function");
    await callback?.();

    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      event: "opencompany.brain_sync_dispatch_failed",
      workspace_id: "wks_123",
      path: "docs/a.md",
      dispatch_status_marked_failed: false,
    });
    expect(mocks.logger.error).toHaveBeenCalledWith("Failed to dispatch Brain GitHub sync event", {
      event: "opencompany.brain_sync_dispatch_failed",
      workspace_id: "wks_123",
      path: "docs/a.md",
      dispatch_status_marked_failed: false,
      error_name: "Error",
      error_message: "Inngest API Error: 401 Event key not found",
    });
  });
});
