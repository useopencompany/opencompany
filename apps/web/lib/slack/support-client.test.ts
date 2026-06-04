import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSupportChannel,
  inviteCustomerToChannel,
  inviteSupportMembers,
  postIntroMessage,
  SlackNotConfiguredError,
} from "./support-client";

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

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.SLACK_SUPPORT_BOT_TOKEN = "xoxb-test";
  process.env.SLACK_SUPPORT_TEAM_ID = "T1";
  process.env.SLACK_SUPPORT_MEMBER_IDS = "U1, U2";
});

describe("createSupportChannel", () => {
  it("creates a private oc-<slug> channel and returns its id", async () => {
    const client = makeClient();
    const id = await createSupportChannel(workspace, { client });
    expect(client.conversations.create).toHaveBeenCalledWith({
      name: "oc-acme-corp",
      is_private: true,
    });
    expect(id).toBe("C123");
  });

  it("retries once with an id-derived suffix on name_taken", async () => {
    const client = makeClient();
    client.conversations.create = vi
      .fn()
      .mockRejectedValueOnce({ data: { error: "name_taken" } })
      .mockResolvedValueOnce({ ok: true, channel: { id: "C999" } });

    const id = await createSupportChannel(workspace, { client });

    expect(client.conversations.create).toHaveBeenCalledTimes(2);
    expect(client.conversations.create.mock.calls[1][0].name).toBe("oc-acme-corp-aaaaaa");
    expect(id).toBe("C999");
  });

  it("throws SlackNotConfiguredError when the bot token is missing", async () => {
    process.env.SLACK_SUPPORT_BOT_TOKEN = "";
    await expect(createSupportChannel(workspace, { client: makeClient() })).rejects.toBeInstanceOf(
      SlackNotConfiguredError,
    );
  });
});

describe("inviteSupportMembers", () => {
  it("invites the configured members", async () => {
    const client = makeClient();
    await inviteSupportMembers("C123", { client });
    expect(client.conversations.invite).toHaveBeenCalledWith({ channel: "C123", users: "U1,U2" });
  });

  it("is a no-op when no members are configured", async () => {
    process.env.SLACK_SUPPORT_MEMBER_IDS = "";
    const client = makeClient();
    await inviteSupportMembers("C123", { client });
    expect(client.conversations.invite).not.toHaveBeenCalled();
  });

  it("treats already_in_channel as success (idempotent retry)", async () => {
    const client = makeClient();
    client.conversations.invite = vi
      .fn()
      .mockRejectedValue({ data: { error: "already_in_channel" } });
    await expect(inviteSupportMembers("C123", { client })).resolves.toBeUndefined();
  });
});

describe("inviteCustomerToChannel", () => {
  it("returns the shareable invite url", async () => {
    const client = makeClient();
    const url = await inviteCustomerToChannel("C123", "c@acme.com", { client });
    expect(client.conversations.inviteShared).toHaveBeenCalledWith({
      channel: "C123",
      emails: ["c@acme.com"],
    });
    expect(url).toBe("https://join.slack.com/share/x");
  });

  it("returns null when Slack provides no url", async () => {
    const client = makeClient();
    client.conversations.inviteShared = vi.fn(async () => ({ ok: true }));
    expect(await inviteCustomerToChannel("C123", "c@acme.com", { client })).toBeNull();
  });
});

describe("postIntroMessage", () => {
  it("posts an intro message to the channel", async () => {
    const client = makeClient();
    await postIntroMessage("C123", { client });
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123" }),
    );
  });
});
