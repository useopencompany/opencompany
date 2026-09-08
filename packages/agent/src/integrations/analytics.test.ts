import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import { beforeEach, expect, it, vi } from "vitest";
import { captureConnectionAddedAnalytics } from "./analytics";

vi.mock("@opencompany/analytics/product/server", () => ({
  captureProductServerEvent: vi.fn(async () => undefined),
}));
beforeEach(() => vi.clearAllMocks());

it.each([undefined, "workspace_1"])(
  "records connection authorization with workspace %s",
  async (workspaceId) => {
    await captureConnectionAddedAnalytics({
      userWorkosId: "user_1",
      provider: "linear",
      connectionId: "connection_1",
      ...(workspaceId ? { workspaceId } : {}),
    });
    expect(captureProductServerEvent).toHaveBeenCalledExactlyOnceWith(
      "connection_added",
      "user_1",
      {
        provider: "linear",
        connection_id: "connection_1",
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
      },
    );
  },
);
