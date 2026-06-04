import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  provisionSupportChannel: vi.fn(),
  isSlackSupportConfigured: vi.fn(),
  sendSlackInviteEmail: vi.fn(),
  upsertPending: vi.fn(),
  markActive: vi.fn(),
  markFailed: vi.fn(),
  getWorkspaceSlackChannel: vi.fn(),
}));

vi.mock("@/lib/slack/support-client", () => ({
  provisionSupportChannel: mocks.provisionSupportChannel,
  isSlackSupportConfigured: mocks.isSlackSupportConfigured,
  SlackNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/email/slack-invite", () => ({ sendSlackInviteEmail: mocks.sendSlackInviteEmail }));
vi.mock("@/lib/slack/data", () => ({
  upsertPending: mocks.upsertPending,
  markActive: mocks.markActive,
  markFailed: mocks.markFailed,
  getWorkspaceSlackChannel: mocks.getWorkspaceSlackChannel,
}));

import { runProvisionSlackSupport } from "@/lib/inngest/provision-slack-support";

type Row = {
  status: string;
  inviteUrl: string | null;
  slackChannelId: string | null;
  error: string | null;
};
let row: Row | null = null;

function fakeStep() {
  return { run: async (_label: string, fn: () => unknown) => fn() } as never;
}

const event = {
  data: { workspaceId: "w1", userId: "u1", customerEmail: "c@acme.com", firstName: "Sam" },
} as never;
const workspace = { id: "w1", name: "Acme" };

describe("runProvisionSlackSupport", () => {
  beforeEach(() => {
    row = null;
    vi.clearAllMocks();
    mocks.isSlackSupportConfigured.mockReturnValue(true);
    mocks.upsertPending.mockImplementation(async () => {
      row ??= { status: "pending", inviteUrl: null, slackChannelId: null, error: null };
      return row;
    });
    mocks.markActive.mockImplementation(
      async (input: { inviteUrl: string | null; slackChannelId: string }) => {
        row = {
          status: "active",
          inviteUrl: input.inviteUrl,
          slackChannelId: input.slackChannelId,
          error: null,
        };
      },
    );
    mocks.markFailed.mockImplementation(async (_id: string, error: string) => {
      row = { status: "failed", inviteUrl: null, slackChannelId: null, error };
    });
    mocks.getWorkspaceSlackChannel.mockImplementation(async () => row);
  });

  it("provisions, marks active, and dispatches the invite email", async () => {
    mocks.provisionSupportChannel.mockResolvedValue({
      channelId: "C1",
      teamId: "T1",
      inviteUrl: "https://join.slack.com/x",
    });

    const result = await runProvisionSlackSupport({ event, step: fakeStep(), workspace });

    expect(mocks.provisionSupportChannel).toHaveBeenCalledWith({
      workspace,
      customerEmail: "c@acme.com",
    });
    expect(mocks.markActive).toHaveBeenCalled();
    expect(mocks.sendSlackInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1", inviteUrl: "https://join.slack.com/x" }),
    );
    expect(result.status).toBe("active");
  });

  it("short-circuits when the row is already active (no second channel)", async () => {
    row = { status: "active", inviteUrl: "https://x", slackChannelId: "C1", error: null };

    await runProvisionSlackSupport({ event, step: fakeStep(), workspace });

    expect(mocks.provisionSupportChannel).not.toHaveBeenCalled();
    expect(mocks.sendSlackInviteEmail).not.toHaveBeenCalled();
  });

  it("no-ops to failed when Slack is not configured (does not throw)", async () => {
    mocks.isSlackSupportConfigured.mockReturnValue(false);

    await expect(
      runProvisionSlackSupport({ event, step: fakeStep(), workspace }),
    ).resolves.not.toThrow();

    expect(mocks.markFailed).toHaveBeenCalled();
    expect(mocks.provisionSupportChannel).not.toHaveBeenCalled();
    expect(mocks.sendSlackInviteEmail).not.toHaveBeenCalled();
  });

  it("marks failed and rethrows on a Slack error (so Inngest retries)", async () => {
    mocks.provisionSupportChannel.mockRejectedValue(new Error("slack boom"));

    await expect(runProvisionSlackSupport({ event, step: fakeStep(), workspace })).rejects.toThrow(
      "slack boom",
    );

    expect(mocks.markFailed).toHaveBeenCalled();
    expect(mocks.sendSlackInviteEmail).not.toHaveBeenCalled();
  });
});
