import { CHAT_ATTACHMENTS_PER_MESSAGE, validateChatAttachment } from "@opencompany/core";

export const SLACK_AGENT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:read",
  "channels:history",
  "files:read",
  "users:read",
  "users:read.email",
  "im:history",
  "reactions:write",
] as const;

export type SlackAgentFile = {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  urlPrivateDownload: string;
};

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

// Deliberately accept only ordinary human messages. The message timestamp deduplicates
// app_mention and message.channels deliveries of the same mention.
export function slackAgentMessage(event: Record<string, unknown>, botUserId: string) {
  if (
    event.bot_id ||
    (event.subtype && event.subtype !== "file_share") ||
    event.hidden ||
    event.user === botUserId
  )
    return null;
  if (event.type !== "app_mention" && event.type !== "message") return null;
  const { channel, user, ts, text, thread_ts: threadTs } = event;
  const files = slackAgentFiles(event.files);
  if (
    typeof channel !== "string" ||
    !/^[CD][A-Z0-9]+$/.test(channel) ||
    typeof user !== "string" ||
    !/^[UW][A-Z0-9]+$/.test(user) ||
    typeof ts !== "string" ||
    !/^\d+\.\d+$/.test(ts) ||
    typeof text !== "string" ||
    text.length > 12000 ||
    (!text.trim() && files.length === 0) ||
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
    files,
    canStart: mention || dm,
  };
}

function slackAgentFiles(value: unknown): SlackAgentFile[] {
  if (!Array.isArray(value)) return [];
  const files: SlackAgentFile[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (files.length >= CHAT_ATTACHMENTS_PER_MESSAGE) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const file = candidate as Record<string, unknown>;
    if (
      typeof file.id !== "string" ||
      !/^[A-Z0-9]+$/.test(file.id) ||
      file.id.length > 255 ||
      seen.has(file.id) ||
      typeof file.name !== "string" ||
      !file.name.trim() ||
      file.name.length > 200 ||
      typeof file.mimetype !== "string" ||
      typeof file.size !== "number" ||
      typeof file.url_private_download !== "string" ||
      file.url_private_download.length > 4096
    )
      continue;
    const validation = validateChatAttachment({
      filename: file.name,
      mediaType: file.mimetype,
      sizeBytes: file.size,
    });
    if (!validation.ok || validation.format !== "image") continue;
    let downloadUrl: URL;
    try {
      downloadUrl = new URL(file.url_private_download);
    } catch {
      continue;
    }
    if (downloadUrl.protocol !== "https:") continue;
    seen.add(file.id);
    files.push({
      id: file.id,
      name: file.name.trim(),
      mediaType: validation.mediaType,
      sizeBytes: file.size,
      urlPrivateDownload: downloadUrl.toString(),
    });
  }
  return files;
}
