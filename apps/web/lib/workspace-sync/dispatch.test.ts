import { captureException } from "@opencompany/observability";
import { after } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchWorkspaceSyncRequested } from "@/lib/workspace-sync/events";
import { scheduleWorkspaceSyncDispatch } from "./dispatch";

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

vi.mock("@/lib/workspace-sync/events", () => ({
  dispatchWorkspaceSyncRequested: vi.fn(),
}));

const afterMock = vi.mocked(after);
const captureExceptionMock = vi.mocked(captureException);
const dispatchWorkspaceSyncRequestedMock = vi.mocked(dispatchWorkspaceSyncRequested);

describe("scheduleWorkspaceSyncDispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches the workspace sync event and logs Inngest event ids", async () => {
    dispatchWorkspaceSyncRequestedMock.mockResolvedValue({
      ids: ["evt_123"],
    } as Awaited<ReturnType<typeof dispatchWorkspaceSyncRequested>>);

    scheduleWorkspaceSyncDispatch({ workspaceId: "wks_123" });

    const callback = afterMock.mock.calls[0]?.[0];
    expect(callback).toBeTypeOf("function");
    await callback?.();

    expect(dispatchWorkspaceSyncRequestedMock).toHaveBeenCalledWith({ workspaceId: "wks_123" });
    expect(mocks.logger.info).toHaveBeenCalledWith("Dispatched workspace GitHub sync event", {
      event: "opencompany.workspace_sync_dispatch_succeeded",
      workspace_id: "wks_123",
      inngest_event_ids: ["evt_123"],
    });
  });

  it("captures and logs dispatch failures", async () => {
    const error = new Error("Inngest API Error: 401 Event key not found");
    dispatchWorkspaceSyncRequestedMock.mockRejectedValue(error);

    scheduleWorkspaceSyncDispatch({ workspaceId: "wks_123" });

    const callback = afterMock.mock.calls[0]?.[0];
    expect(callback).toBeTypeOf("function");
    await callback?.();

    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      event: "opencompany.workspace_sync_dispatch_failed",
      workspace_id: "wks_123",
    });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "Failed to dispatch workspace GitHub sync event",
      {
        event: "opencompany.workspace_sync_dispatch_failed",
        workspace_id: "wks_123",
        error_name: "Error",
        error_message: "Inngest API Error: 401 Event key not found",
      },
    );
  });
});
