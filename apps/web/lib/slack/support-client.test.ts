import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSupportChannel,
  inviteCustomerToChannel,
  inviteSupportMembers,
  postIntroMessage,
  SlackNotConfiguredError,
  supportChannelName,
  supportChannelPurpose,
} from "./support-client";

const originalEnv = { ...process.env };

function makeClient() {
  return {
    conversations: {
      create: vi.fn(async () => ({ ok: true, channel: { id: "C123" } })),
      invite: vi.fn(async () => ({ ok: true })),
      inviteShared: vi.fn(async () => ({ ok: true, url: "https://join.slack.com/share/x" })),
      list: vi.fn(async () => ({ ok: true, channels: [] })),
      setPurpose: vi.fn(async () => ({ ok: true })),
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
  it("creates a private oc-<slug>-<suffix> channel and returns its id", async () => {
    const client = makeClient();
    const id = await createSupportChannel(workspace, { client });
    expect(client.conversations.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: supportChannelName(workspace), is_private: true }),
    );
    expect(supportChannelName(workspace)).toMatch(/^oc-acme-corp-[0-9a-f]{6}$/);
    // ownership marker is stamped so a later name_taken retry can verify the channel is ours
    expect(client.conversations.setPurpose).toHaveBeenCalledWith({
      channel: "C123",
      purpose: supportChannelPurpose(workspace.id),
    });
    expect(id).toBe("C123");
  });

  it("adopts this workspace's own channel on name_taken (purpose matches)", async () => {
    const client = makeClient();
    client.conversations.create = vi.fn().mockRejectedValue({ data: { error: "name_taken" } });
    client.conversations.list = vi.fn(async () => ({
      ok: true,
      channels: [
        {
          id: "C-existing",
          name: supportChannelName(workspace),
          purpose: { value: supportChannelPurpose(workspace.id) },
        },
      ],
    }));

    const id = await createSupportChannel(workspace, { client });

    expect(id).toBe("C-existing");
    expect(client.conversations.create).toHaveBeenCalledTimes(1);
    expect(client.conversations.list).toHaveBeenCalled();
  });

  it("refuses to adopt a channel owned by a DIFFERENT workspace (no cross-tenant leak)", async () => {
    const client = makeClient();
    client.conversations.create = vi.fn().mockRejectedValue({ data: { error: "name_taken" } });
    client.conversations.list = vi.fn(async () => ({
      ok: true,
      channels: [
        {
          id: "C-other-tenant",
          name: supportChannelName(workspace),
          purpose: { value: supportChannelPurpose("wks_someone_else") },
        },
      ],
    }));

    await expect(createSupportChannel(workspace, { client })).rejects.toMatchObject({
      name: "SlackProvisionError",
      slackError: "name_taken",
    });
  });

  it("adopts an unmarked channel and (re)asserts ownership", async () => {
    const client = makeClient();
    client.conversations.create = vi.fn().mockRejectedValue({ data: { error: "name_taken" } });
    client.conversations.list = vi.fn(async () => ({
      ok: true,
      channels: [{ id: "C-unmarked", name: supportChannelName(workspace) }],
    }));

    const id = await createSupportChannel(workspace, { client });

    expect(id).toBe("C-unmarked");
    expect(client.conversations.setPurpose).toHaveBeenCalledWith({
      channel: "C-unmarked",
      purpose: supportChannelPurpose(workspace.id),
    });
  });

  it("paginates conversations.list to find the adopted channel", async () => {
    const client = makeClient();
    client.conversations.create = vi.fn().mockRejectedValue({ data: { error: "name_taken" } });
    client.conversations.list = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        channels: [{ id: "C-other", name: "oc-something-else" }],
        response_metadata: { next_cursor: "page2" },
      })
      .mockResolvedValueOnce({
        ok: true,
        channels: [{ id: "C-existing", name: supportChannelName(workspace) }],
      });

    const id = await createSupportChannel(workspace, { client });

    expect(id).toBe("C-existing");
    expect(client.conversations.list).toHaveBeenCalledTimes(2);
  });

  it("throws when name_taken but the channel can't be found", async () => {
    const client = makeClient();
    client.conversations.create = vi.fn().mockRejectedValue({ data: { error: "name_taken" } });
    client.conversations.list = vi.fn(async () => ({ ok: true, channels: [] }));

    await expect(createSupportChannel(workspace, { client })).rejects.toMatchObject({
      name: "SlackProvisionError",
      slackError: "name_taken",
    });
  });

  it("throws SlackNotConfiguredError when the bot token is missing and no client is injected", async () => {
    process.env.SLACK_SUPPORT_BOT_TOKEN = "";
    await expect(createSupportChannel(workspace)).rejects.toBeInstanceOf(SlackNotConfiguredError);
  });

  it("uses an injected client without requiring the bot token", async () => {
    // An injected client is honored before the env check, so tests (and any caller
    // bringing their own client) never need SLACK_SUPPORT_BOT_TOKEN set.
    process.env.SLACK_SUPPORT_BOT_TOKEN = "";
    const client = makeClient();
    const id = await createSupportChannel(workspace, { client });
    expect(client.conversations.create).toHaveBeenCalled();
    expect(id).toBe("C123");
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

  it("does NOT treat is_archived as benign — surfaces it as an error", async () => {
    const client = makeClient();
    client.conversations.invite = vi.fn().mockRejectedValue({ data: { error: "is_archived" } });
    await expect(inviteSupportMembers("C123", { client })).rejects.toMatchObject({
      name: "SlackProvisionError",
      slackError: "is_archived",
    });
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

  it("returns null (benign) when the customer is already invited on retry", async () => {
    const client = makeClient();
    client.conversations.inviteShared = vi
      .fn()
      .mockRejectedValue({ data: { error: "already_in_channel" } });
    expect(await inviteCustomerToChannel("C123", "c@acme.com", { client })).toBeNull();
  });

  it("throws SlackProvisionError on a non-benign Slack error", async () => {
    const client = makeClient();
    client.conversations.inviteShared = vi
      .fn()
      .mockRejectedValue({ data: { error: "channel_not_found" } });
    await expect(inviteCustomerToChannel("C123", "c@acme.com", { client })).rejects.toMatchObject({
      name: "SlackProvisionError",
      slackError: "channel_not_found",
    });
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

  it("propagates a Slack error (the orchestrator decides best-effort handling)", async () => {
    const client = makeClient();
    client.chat.postMessage = vi.fn().mockRejectedValue({ data: { error: "rate_limited" } });
    await expect(postIntroMessage("C123", { client })).rejects.toBeTruthy();
  });
});
