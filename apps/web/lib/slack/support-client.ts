import { WebClient } from "@slack/web-api";
import { channelName, workspaceChannelSlug } from "./slugify";

export type ProvisionInput = {
  workspace: { id: string; name: string };
  customerEmail: string;
};

export type ProvisionResult = {
  channelId: string;
  teamId: string | null;
  inviteUrl: string | null;
};

export class SlackNotConfiguredError extends Error {
  constructor(message = "SLACK_SUPPORT_BOT_TOKEN is not configured") {
    super(message);
    this.name = "SlackNotConfiguredError";
  }
}

export class SlackProvisionError extends Error {
  slackError?: string | undefined;
  constructor(message: string, slackError?: string) {
    super(message);
    this.name = "SlackProvisionError";
    this.slackError = slackError;
  }
}

// Only this module talks to @slack/web-api, so the rest of the app has a single
// seam to mock and never imports the SDK directly. Narrow structural type = the
// real WebClient satisfies it and tests can pass a tiny mock.
type SlackProvisionClient = {
  conversations: {
    create: (args: {
      name: string;
      is_private?: boolean;
    }) => Promise<{ channel?: { id?: string } }>;
    invite: (args: { channel: string; users: string }) => Promise<unknown>;
    inviteShared: (args: { channel: string; emails: string[] }) => Promise<{ url?: string }>;
  };
  chat: { postMessage: (args: { channel: string; text: string }) => Promise<unknown> };
};

function getConfig() {
  return {
    token: process.env.SLACK_SUPPORT_BOT_TOKEN?.trim() ?? "",
    teamId: process.env.SLACK_SUPPORT_TEAM_ID?.trim() || null,
    memberIds: (process.env.SLACK_SUPPORT_MEMBER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

export function isSlackSupportConfigured(): boolean {
  return getConfig().token.length > 0;
}

function slackErrorCode(error: unknown): string | undefined {
  return (error as { data?: { error?: string } } | undefined)?.data?.error;
}

export async function provisionSupportChannel(
  input: ProvisionInput,
  deps?: { client?: SlackProvisionClient },
): Promise<ProvisionResult> {
  const { token, teamId, memberIds } = getConfig();
  if (!token) throw new SlackNotConfiguredError();
  const client = deps?.client ?? (new WebClient(token) as unknown as SlackProvisionClient);

  const slug = workspaceChannelSlug(input.workspace.name);

  let channelId: string | undefined;
  try {
    const created = await client.conversations.create({
      name: channelName(slug),
      is_private: true,
    });
    channelId = created.channel?.id;
  } catch (error) {
    if (slackErrorCode(error) !== "name_taken") {
      throw new SlackProvisionError("conversations.create failed", slackErrorCode(error));
    }
    // Collision: retry once with a short id-derived suffix.
    const suffix = input.workspace.id
      .replace(/[^a-z0-9]/gi, "")
      .slice(-6)
      .toLowerCase();
    const retry = await client.conversations.create({
      name: channelName(slug, suffix),
      is_private: true,
    });
    channelId = retry.channel?.id;
  }
  if (!channelId) throw new SlackProvisionError("conversations.create returned no channel id");

  if (memberIds.length > 0) {
    await client.conversations.invite({ channel: channelId, users: memberIds.join(",") });
  }

  const shared = await client.conversations.inviteShared({
    channel: channelId,
    emails: [input.customerEmail],
  });
  const inviteUrl = (shared as { url?: string }).url ?? null;

  await client.chat.postMessage({
    channel: channelId,
    text: "👋 This is your private support channel with OpenCompany. Ask us anything here — we read it in real time.",
  });

  return { channelId, teamId, inviteUrl };
}
