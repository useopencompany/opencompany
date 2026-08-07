import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";
import { upsertGoatBrainSource } from "@opencompany/db/brain-sources";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertGoatBrainSourceWithAnalytics } from "./brain-source-analytics";

vi.mock("@opencompany/analytics/goat/server", () => ({
  captureGoatServerEvent: vi.fn(async () => undefined),
}));

vi.mock("@opencompany/db/brain-sources", () => ({
  upsertGoatBrainSource: vi.fn(),
}));

const captureGoatServerEventMock = vi.mocked(captureGoatServerEvent);
const upsertGoatBrainSourceMock = vi.mocked(upsertGoatBrainSource);

const input = {
  workspaceId: "workspace_123",
  brainRef: "brain_123",
  provider: "slack" as const,
  integrationId: "integration_123",
  userWorkosId: "user_123",
  createdByWorkosId: "user_123",
  enabled: true,
};

describe("upsertGoatBrainSourceWithAnalytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures a newly enabled Brain source", async () => {
    upsertGoatBrainSourceMock.mockResolvedValue({
      id: "source_123",
      created: true,
    });

    await expect(upsertGoatBrainSourceWithAnalytics(input)).resolves.toEqual({
      id: "source_123",
      created: true,
    });

    expect(upsertGoatBrainSourceMock).toHaveBeenCalledWith({
      brainRef: "brain_123",
      provider: "slack",
      integrationId: "integration_123",
      userWorkosId: "user_123",
      createdByWorkosId: "user_123",
      enabled: true,
    });
    expect(captureGoatServerEventMock).toHaveBeenCalledWith("brain_source_added", "user_123", {
      workspace_id: "workspace_123",
      brain_id: "brain_123",
      provider: "slack",
    });
  });

  it("does not capture updates or newly disabled rows", async () => {
    upsertGoatBrainSourceMock.mockResolvedValueOnce({
      id: "source_123",
      created: false,
    });
    await upsertGoatBrainSourceWithAnalytics(input);

    upsertGoatBrainSourceMock.mockResolvedValueOnce({
      id: "source_456",
      created: true,
    });
    await upsertGoatBrainSourceWithAnalytics({ ...input, enabled: false });

    expect(captureGoatServerEventMock).not.toHaveBeenCalled();
  });
});
