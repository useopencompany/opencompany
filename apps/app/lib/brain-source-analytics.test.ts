import { captureServerEvent } from "@opencompany/analytics/server";
import { upsertBrainSource } from "@opencompany/db/brain-sources";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertBrainSourceWithAnalytics } from "./brain-source-analytics";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/brain-sources", () => ({
  upsertBrainSource: vi.fn(),
}));

const captureServerEventMock = vi.mocked(captureServerEvent);
const upsertBrainSourceMock = vi.mocked(upsertBrainSource);

const input = {
  workspaceId: "workspace_123",
  brainRef: "brain_123",
  provider: "slack" as const,
  integrationId: "integration_123",
  userWorkosId: "user_123",
  createdByWorkosId: "user_123",
  enabled: true,
};

describe("upsertBrainSourceWithAnalytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures a newly enabled Brain source", async () => {
    upsertBrainSourceMock.mockResolvedValue({
      id: "source_123",
      created: true,
    });

    await expect(upsertBrainSourceWithAnalytics(input)).resolves.toEqual({
      id: "source_123",
      created: true,
    });

    expect(upsertBrainSourceMock).toHaveBeenCalledWith({
      brainRef: "brain_123",
      provider: "slack",
      integrationId: "integration_123",
      userWorkosId: "user_123",
      createdByWorkosId: "user_123",
      enabled: true,
    });
    expect(captureServerEventMock).toHaveBeenCalledWith("brain_source_added", "user_123", {
      workspace_id: "workspace_123",
      brain_id: "brain_123",
      provider: "slack",
    });
  });

  it("does not capture updates or newly disabled rows", async () => {
    upsertBrainSourceMock.mockResolvedValueOnce({
      id: "source_123",
      created: false,
    });
    await upsertBrainSourceWithAnalytics(input);

    upsertBrainSourceMock.mockResolvedValueOnce({
      id: "source_456",
      created: true,
    });
    await upsertBrainSourceWithAnalytics({ ...input, enabled: false });

    expect(captureServerEventMock).not.toHaveBeenCalled();
  });
});
