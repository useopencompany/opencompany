import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isSlackSupportConfigured: vi.fn(),
  listRecoverableSlackChannels: vi.fn(),
  dispatchSlackSupportChannelRequested: vi.fn(),
}));

vi.mock("@/lib/slack/support-client", () => ({
  isSlackSupportConfigured: mocks.isSlackSupportConfigured,
}));
vi.mock("@/lib/slack/data", () => ({
  listRecoverableSlackChannels: mocks.listRecoverableSlackChannels,
}));
vi.mock("@/lib/slack/events", () => ({
  dispatchSlackSupportChannelRequested: mocks.dispatchSlackSupportChannelRequested,
}));

import { runSlackSupportRecoverySweep } from "@/lib/slack/recovery";

function fakeStep() {
  return { run: async (_label: string, fn: () => unknown) => fn() } as never;
}

describe("runSlackSupportRecoverySweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isSlackSupportConfigured.mockReturnValue(true);
    mocks.listRecoverableSlackChannels.mockResolvedValue([]);
    mocks.dispatchSlackSupportChannelRequested.mockResolvedValue(undefined);
  });

  it("no-ops when Slack support is not configured (no query, no dispatch)", async () => {
    mocks.isSlackSupportConfigured.mockReturnValue(false);

    const result = await runSlackSupportRecoverySweep(fakeStep());

    expect(result).toEqual({ redispatched: 0 });
    expect(mocks.listRecoverableSlackChannels).not.toHaveBeenCalled();
    expect(mocks.dispatchSlackSupportChannelRequested).not.toHaveBeenCalled();
  });

  it("no-ops when nothing is recoverable", async () => {
    const result = await runSlackSupportRecoverySweep(fakeStep());

    expect(result).toEqual({ redispatched: 0 });
    expect(mocks.dispatchSlackSupportChannelRequested).not.toHaveBeenCalled();
  });

  it("re-dispatches provisioning for each recoverable workspace", async () => {
    mocks.listRecoverableSlackChannels.mockResolvedValue([
      { workspaceId: "w1", userId: "u1", customerEmail: "a@x.com", firstName: "A" },
      { workspaceId: "w2", userId: "u2", customerEmail: "b@x.com", firstName: null },
    ]);

    const result = await runSlackSupportRecoverySweep(fakeStep());

    expect(result).toEqual({ redispatched: 2 });
    expect(mocks.dispatchSlackSupportChannelRequested).toHaveBeenCalledTimes(2);
    expect(mocks.dispatchSlackSupportChannelRequested).toHaveBeenCalledWith({
      workspaceId: "w1",
      userId: "u1",
      customerEmail: "a@x.com",
      firstName: "A",
    });
    expect(mocks.dispatchSlackSupportChannelRequested).toHaveBeenCalledWith({
      workspaceId: "w2",
      userId: "u2",
      customerEmail: "b@x.com",
      firstName: null,
    });
  });
});
