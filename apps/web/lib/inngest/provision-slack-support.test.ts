import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupportChannel: vi.fn(),
  inviteSupportMembers: vi.fn(),
  inviteCustomerToChannel: vi.fn(),
  postIntroMessage: vi.fn(),
  getSupportTeamId: vi.fn(),
  isSlackSupportConfigured: vi.fn(),
  upsertPending: vi.fn(),
  setSlackChannelId: vi.fn(),
  markActive: vi.fn(),
  markFailed: vi.fn(),
  getWorkspaceSlackChannel: vi.fn(),
}));

vi.mock("@/lib/slack/support-client", () => ({
  createSupportChannel: mocks.createSupportChannel,
  inviteSupportMembers: mocks.inviteSupportMembers,
  inviteCustomerToChannel: mocks.inviteCustomerToChannel,
  postIntroMessage: mocks.postIntroMessage,
  getSupportTeamId: mocks.getSupportTeamId,
  isSlackSupportConfigured: mocks.isSlackSupportConfigured,
  SlackNotConfiguredError: class extends Error {},
}));
vi.mock("@/lib/slack/data", () => ({
  upsertPending: mocks.upsertPending,
  setSlackChannelId: mocks.setSlackChannelId,
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
    mocks.getSupportTeamId.mockReturnValue("T1");
    mocks.createSupportChannel.mockResolvedValue("C1");
    mocks.inviteSupportMembers.mockResolvedValue(undefined);
    mocks.inviteCustomerToChannel.mockResolvedValue("https://join.slack.com/x");
    mocks.postIntroMessage.mockResolvedValue(undefined);
    mocks.upsertPending.mockImplementation(async () => {
      row ??= { status: "pending", inviteUrl: null, slackChannelId: null, error: null };
      return row;
    });
    mocks.setSlackChannelId.mockImplementation(async (input: { slackChannelId: string }) => {
      if (row) row.slackChannelId = input.slackChannelId;
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

  it("creates the channel, persists its id, invites, and marks active", async () => {
    const result = await runProvisionSlackSupport({ event, step: fakeStep(), workspace });

    expect(mocks.createSupportChannel).toHaveBeenCalledWith(workspace);
    expect(mocks.setSlackChannelId).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "w1", slackChannelId: "C1", slackTeamId: "T1" }),
    );
    expect(mocks.inviteSupportMembers).toHaveBeenCalledWith("C1");
    // inviteShared with the customer email is what triggers Slack's own invite email.
    expect(mocks.inviteCustomerToChannel).toHaveBeenCalledWith("C1", "c@acme.com");
    expect(mocks.markActive).toHaveBeenCalledWith(
      expect.objectContaining({ inviteUrl: "https://join.slack.com/x" }),
    );
    expect(result.status).toBe("active");
  });

  it("resumes the existing channel id without creating a second channel", async () => {
    // Simulates an Inngest retry after the channel was already created.
    row = { status: "pending", inviteUrl: null, slackChannelId: "C-existing", error: null };

    await runProvisionSlackSupport({ event, step: fakeStep(), workspace });

    expect(mocks.createSupportChannel).not.toHaveBeenCalled();
    expect(mocks.inviteCustomerToChannel).toHaveBeenCalledWith("C-existing", "c@acme.com");
    expect(mocks.markActive).toHaveBeenCalledWith(
      expect.objectContaining({ slackChannelId: "C-existing" }),
    );
  });

  it("short-circuits when the row is already active (no second channel)", async () => {
    row = { status: "active", inviteUrl: "https://x", slackChannelId: "C1", error: null };

    await runProvisionSlackSupport({ event, step: fakeStep(), workspace });

    expect(mocks.createSupportChannel).not.toHaveBeenCalled();
  });

  it("no-ops to failed when Slack is not configured (does not throw)", async () => {
    mocks.isSlackSupportConfigured.mockReturnValue(false);

    await expect(
      runProvisionSlackSupport({ event, step: fakeStep(), workspace }),
    ).resolves.not.toThrow();

    expect(mocks.markFailed).toHaveBeenCalled();
    expect(mocks.createSupportChannel).not.toHaveBeenCalled();
  });

  it("marks failed and rethrows on a Slack error (so Inngest retries)", async () => {
    mocks.createSupportChannel.mockRejectedValue(new Error("slack boom"));

    await expect(runProvisionSlackSupport({ event, step: fakeStep(), workspace })).rejects.toThrow(
      "slack boom",
    );

    expect(mocks.markFailed).toHaveBeenCalled();
  });
});
