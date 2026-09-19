export const SLACK_AGENT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:read",
  "channels:history",
  "users:read",
  "users:read.email",
  "im:history",
  "reactions:write",
] as const;

export function slackAgentManifest(input: { name: string; eventsUrl?: string }) {
  return {
    display_information: { name: input.name.trim().slice(0, 35) || "Company agent" },
    features: {
      bot_user: {
        display_name: input.name.trim().slice(0, 80) || "Company agent",
        always_online: true,
      },
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    },
    oauth_config: { scopes: { bot: [...SLACK_AGENT_SCOPES] } },
    settings: {
      ...(input.eventsUrl
        ? {
            event_subscriptions: {
              request_url: input.eventsUrl,
              bot_events: [
                "app_mention",
                "message.channels",
                "message.im",
                "app_uninstalled",
                "tokens_revoked",
              ],
            },
          }
        : {}),
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

// Deliberately accept only ordinary human text. The message timestamp deduplicates
// app_mention and message.channels deliveries of the same mention.
export function slackAgentMessage(event: Record<string, unknown>, botUserId: string) {
  if (event.bot_id || event.subtype || event.hidden || event.files || event.user === botUserId)
    return null;
  if (event.type !== "app_mention" && event.type !== "message") return null;
  const { channel, user, ts, text, thread_ts: threadTs } = event;
  if (
    typeof channel !== "string" ||
    !/^[CD][A-Z0-9]+$/.test(channel) ||
    typeof user !== "string" ||
    !/^[UW][A-Z0-9]+$/.test(user) ||
    typeof ts !== "string" ||
    !/^\d+\.\d+$/.test(ts) ||
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 12000 ||
    (threadTs !== undefined && (typeof threadTs !== "string" || !/^\d+\.\d+$/.test(threadTs)))
  )
    return null;
  const mention = event.type === "app_mention";
  const dm = event.channel_type === "im" && channel.startsWith("D");
  if (!mention && !dm && (event.channel_type !== "channel" || !threadTs || threadTs === ts))
    return null;
  return {
    channelId: channel,
    slackUserId: user,
    messageTs: ts,
    threadTs: typeof threadTs === "string" ? threadTs : ts,
    text: text.trim(),
    canStart: mention || dm,
  };
}
