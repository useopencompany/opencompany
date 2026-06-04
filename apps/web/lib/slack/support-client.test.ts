import { beforeEach, describe, expect, it, vi } from "vitest";
import { provisionSupportChannel, SlackNotConfiguredError } from "./support-client";

const originalEnv = { ...process.env };

function makeClient() {
  return {
    conversations: {
      create: vi.fn(async () => ({ ok: true, channel: { id: "C123" } })),
      invite: vi.fn(async () => ({ ok: true })),
      inviteShared: vi.fn(async () => ({ ok: true, url: "https://join.slack.com/share/x" })),
    },
    chat: { postMessage: vi.fn(async () => ({ ok: true })) },
  };
}

const workspace = { id: "wks_aaaaaaaa", name: "Acme Corp" };

describe("provisionSupportChannel", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SLACK_SUPPORT_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_SUPPORT_TEAM_ID = "T1";
    process.env.SLACK_SUPPORT_MEMBER_IDS = "U1, U2";
  });

  it("creates a private channel, invites the team, sends a shared invite, posts an intro", async () => {
    const client = makeClient();

    const result = await provisionSupportChannel(
      { workspace, customerEmail: "c@acme.com" },
      { client },
    );

    expect(client.conversations.create).toHaveBeenCalledWith({
      name: "oc-acme-corp",
      is_private: true,
    });
    expect(client.conversations.invite).toHaveBeenCalledWith({ channel: "C123", users: "U1,U2" });
    expect(client.conversations.inviteShared).toHaveBeenCalledWith({
      channel: "C123",
      emails: ["c@acme.com"],
    });
    expect(client.chat.postMessage).toHaveBeenCalled();
    expect(result).toEqual({
      channelId: "C123",
      teamId: "T1",
      inviteUrl: "https://join.slack.com/share/x",
    });
  });

  it("retries with a suffix on name_taken", async () => {
    process.env.SLACK_SUPPORT_MEMBER_IDS = "";
    const client = makeClient();
    client.conversations.create = vi
      .fn()
      .mockRejectedValueOnce({ data: { error: "name_taken" } })
      .mockResolvedValueOnce({ ok: true, channel: { id: "C999" } });

    const result = await provisionSupportChannel(
      { workspace, customerEmail: "c@acme.com" },
      { client },
    );

    expect(client.conversations.create).toHaveBeenCalledTimes(2);
    expect(client.conversations.create.mock.calls[1][0].name).toBe("oc-acme-corp-aaaaaa");
    expect(client.conversations.invite).not.toHaveBeenCalled();
    expect(result.channelId).toBe("C999");
  });

  it("throws SlackNotConfiguredError when the bot token is missing", async () => {
    process.env.SLACK_SUPPORT_BOT_TOKEN = "";
    await expect(
      provisionSupportChannel({ workspace, customerEmail: "c@acme.com" }, { client: makeClient() }),
    ).rejects.toBeInstanceOf(SlackNotConfiguredError);
  });

  it("captures a null invite url when Slack returns none", async () => {
    const client = makeClient();
    client.conversations.inviteShared = vi.fn(async () => ({ ok: true }));

    const result = await provisionSupportChannel(
      { workspace, customerEmail: "c@acme.com" },
      { client },
    );

    expect(result.inviteUrl).toBeNull();
  });
});
