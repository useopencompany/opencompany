import { createHash } from "node:crypto";
import {
  loadGoatGoogleDriveWatchChannel,
  requestGoatGoogleDriveCursorWake,
} from "@opencompany/db/google-drive";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { triggerGoatGoogleDriveSyncWake } from "@/lib/task-runner";
import { POST } from "./route";

vi.mock("@opencompany/db/google-drive", () => ({
  loadGoatGoogleDriveWatchChannel: vi.fn(),
  requestGoatGoogleDriveCursorWake: vi.fn(),
}));

vi.mock("@/lib/task-runner", () => ({
  triggerGoatGoogleDriveSyncWake: vi.fn(async () => {}),
}));

describe("POST /api/webhooks/google-drive", () => {
  beforeEach(() => vi.clearAllMocks());

  it("turns an authenticated notification into an idempotent cursor wake", async () => {
    vi.mocked(loadGoatGoogleDriveWatchChannel).mockResolvedValue({
      id: "channel_1",
      cursorId: "cursor_1",
      tokenHash: sha256("secret-token"),
      resourceId: "resource_1",
      status: "active",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await POST(driveNotification());

    expect(response.status).toBe(204);
    expect(requestGoatGoogleDriveCursorWake).toHaveBeenCalledWith("cursor_1");
    expect(triggerGoatGoogleDriveSyncWake).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid channel token without waking", async () => {
    vi.mocked(loadGoatGoogleDriveWatchChannel).mockResolvedValue({
      id: "channel_1",
      cursorId: "cursor_1",
      tokenHash: sha256("different-token"),
      resourceId: "resource_1",
      status: "active",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await POST(driveNotification());

    expect(response.status).toBe(401);
    expect(requestGoatGoogleDriveCursorWake).not.toHaveBeenCalled();
  });

  it("accepts the early sync notification for a creating channel", async () => {
    vi.mocked(loadGoatGoogleDriveWatchChannel).mockResolvedValue({
      id: "channel_1",
      cursorId: "cursor_1",
      tokenHash: sha256("secret-token"),
      resourceId: null,
      status: "creating",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await POST(driveNotification("sync"));

    expect(response.status).toBe(204);
    expect(requestGoatGoogleDriveCursorWake).toHaveBeenCalledWith("cursor_1");
  });
});

function driveNotification(state = "change") {
  return new Request("https://goat.test/api/webhooks/google-drive", {
    method: "POST",
    headers: {
      "x-goog-channel-id": "channel_1",
      "x-goog-channel-token": "secret-token",
      "x-goog-resource-id": "resource_1",
      "x-goog-resource-state": state,
    },
  });
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
