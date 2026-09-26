import { describe, expect, it } from "vitest";
import { slackAgentManifest, slackAgentMessage } from "./slack-agent";

describe("dedicated Slack agents", () => {
  it("creates an installable app before its signing secret is stored, then enables signed events", () => {
    const initial = slackAgentManifest({ name: "Support" });
    expect(initial.settings).not.toHaveProperty("event_subscriptions");
    expect(initial.oauth_config.scopes.bot).toContain("app_mentions:read");
    expect(initial.oauth_config.scopes.bot).toContain("files:read");
    expect(initial.oauth_config.scopes.bot).toContain("files:write");
    expect(initial.oauth_config.scopes.bot).not.toContain("chat:write.customize");
    expect(
      slackAgentManifest({ name: "Support", eventsUrl: "https://api.example.com/events" }).settings
        .event_subscriptions,
    ).toEqual({
      request_url: "https://api.example.com/events",
      bot_events: [
        "app_mention",
        "message.channels",
        "message.im",
        "app_uninstalled",
        "tokens_revoked",
      ],
    });
  });
  const mention = {
    type: "app_mention",
    channel: "C1",
    user: "U1",
    ts: "100.001",
    text: "<@UBOT> help",
  };
  it("starts from mentions and DMs, including mentions in existing threads", () => {
    expect(slackAgentMessage(mention, "UBOT")).toMatchObject({
      canStart: true,
      threadTs: "100.001",
    });
    expect(slackAgentMessage({ ...mention, thread_ts: "99.001" }, "UBOT")).toMatchObject({
      canStart: true,
      threadTs: "99.001",
    });
    expect(
      slackAgentMessage({ ...mention, type: "message", channel: "D1", channel_type: "im" }, "UBOT"),
    ).toMatchObject({ canStart: true });
  });
  it("only accepts ordinary channel messages as replies to existing conversations", () => {
    expect(
      slackAgentMessage({ ...mention, type: "message", channel_type: "channel" }, "UBOT"),
    ).toBeNull();
    expect(
      slackAgentMessage(
        { ...mention, type: "message", channel_type: "channel", thread_ts: "99.001" },
        "UBOT",
      ),
    ).toMatchObject({ canStart: false });
  });
  it("accepts supported Slack images without letting other files block the message", () => {
    const image = {
      id: "F1",
      name: "bug.png",
      mimetype: "image/png",
      size: 4,
      url_private_download: "https://files.slack.com/files-pri/T1-F1/bug.png",
    };
    expect(
      slackAgentMessage({ ...mention, subtype: "file_share", files: [image] }, "UBOT"),
    ).toMatchObject({
      files: [
        {
          id: "F1",
          name: "bug.png",
          mediaType: "image/png",
          sizeBytes: 4,
          urlPrivateDownload: "https://files.slack.com/files-pri/T1-F1/bug.png",
        },
      ],
    });
    expect(
      slackAgentMessage(
        {
          ...mention,
          type: "message",
          channel: "D1",
          channel_type: "im",
          text: "",
          files: [image],
        },
        "UBOT",
      ),
    ).toMatchObject({ canStart: true, text: "", files: [{ id: "F1" }] });
    expect(
      slackAgentMessage(
        {
          ...mention,
          files: [{ ...image, id: "F2", name: "notes.txt", mimetype: "text/plain" }],
        },
        "UBOT",
      ),
    ).toMatchObject({ files: [] });
  });
  it.each([
    { user: "UBOT" },
    { bot_id: "B1" },
    { subtype: "message_changed" },
    { ts: "bad" },
    { channel: "G1" },
    { thread_ts: {} },
    { text: "" },
  ])("ignores unsupported events: %j", (change) => {
    expect(slackAgentMessage({ ...mention, ...change }, "UBOT")).toBeNull();
  });
});
