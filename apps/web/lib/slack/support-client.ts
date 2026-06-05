import { WebClient } from "@slack/web-api";
import { channelName, workspaceChannelSlug } from "./slugify";

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

export type SupportClientDeps = { client?: SlackProvisionClient };

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

export function getSupportTeamId(): string | null {
  return getConfig().teamId;
}

function resolveClient(deps?: SupportClientDeps): SlackProvisionClient {
  // Honor an injected client before touching env: tests (and any caller that
  // brings its own client) shouldn't need SLACK_SUPPORT_BOT_TOKEN set.
  if (deps?.client) return deps.client;
  const { token } = getConfig();
  if (!token) throw new SlackNotConfiguredError();
  return new WebClient(token) as unknown as SlackProvisionClient;
}

function slackErrorCode(error: unknown): string | undefined {
  return (error as { data?: { error?: string } } | undefined)?.data?.error;
}

// Some Slack errors are benign for our idempotent retry model: re-inviting a member
// who is already in the channel, etc. Treat them as success.
function isBenign(error: unknown): boolean {
  const code = slackErrorCode(error);
  return code === "already_in_channel" || code === "cant_invite_self";
}

// A retry can re-invite a customer whose invite already landed (the first call reached
// Slack but its response was lost). Slack then reports "already invited / in channel" —
// success for our idempotent model: no fresh url, but the invite exists, so don't fail.
function isCustomerInviteBenign(error: unknown): boolean {
  const code = slackErrorCode(error);
  return code === "already_in_channel" || code === "already_invited" || code === "already_shared";
}

// Step 1 of provisioning: create the private channel. Each call is its own Inngest
// step in the orchestrator, and the channel id is persisted immediately after, so a
// retry never re-creates (no orphaned channels).
export async function createSupportChannel(
  workspace: { id: string; name: string },
  deps?: SupportClientDeps,
): Promise<string> {
  const client = resolveClient(deps);
  const slug = workspaceChannelSlug(workspace.name);

  try {
    const created = await client.conversations.create({
      name: channelName(slug),
      is_private: true,
    });
    const id = created.channel?.id;
    if (!id) throw new SlackProvisionError("conversations.create returned no channel id");
    return id;
  } catch (error) {
    if (error instanceof SlackProvisionError) throw error;
    if (slackErrorCode(error) !== "name_taken") {
      throw new SlackProvisionError("conversations.create failed", slackErrorCode(error));
    }
    // Genuine cross-workspace name collision: retry once with an id-derived suffix
    // (unique per workspace, so this never re-collides for the same workspace).
    const suffix = workspace.id
      .replace(/[^a-z0-9]/gi, "")
      .slice(-6)
      .toLowerCase();
    try {
      const retry = await client.conversations.create({
        name: channelName(slug, suffix),
        is_private: true,
      });
      const id = retry.channel?.id;
      if (!id) throw new SlackProvisionError("conversations.create returned no channel id");
      return id;
    } catch (retryError) {
      if (retryError instanceof SlackProvisionError) throw retryError;
      throw new SlackProvisionError(
        "conversations.create failed on collision retry",
        slackErrorCode(retryError),
      );
    }
  }
}

// Step 2: invite the OC support members. No-op when none configured; re-invites of
// already-present members are treated as success so a retry stays idempotent.
export async function inviteSupportMembers(
  channelId: string,
  deps?: SupportClientDeps,
): Promise<void> {
  const { memberIds } = getConfig();
  if (memberIds.length === 0) return;
  const client = resolveClient(deps);
  try {
    await client.conversations.invite({ channel: channelId, users: memberIds.join(",") });
  } catch (error) {
    if (isBenign(error)) return;
    throw new SlackProvisionError("conversations.invite failed", slackErrorCode(error));
  }
}

// Step 3: send the external Slack Connect invite to the customer; return the
// shareable invite url (or null if Slack returns none).
export async function inviteCustomerToChannel(
  channelId: string,
  customerEmail: string,
  deps?: SupportClientDeps,
): Promise<string | null> {
  const client = resolveClient(deps);
  try {
    const shared = await client.conversations.inviteShared({
      channel: channelId,
      emails: [customerEmail],
    });
    // Guard the value at runtime — Slack's inviteShared only returns a `url` for
    // email invites, so anything non-string degrades to "no invite link" rather
    // than a broken email.
    return typeof shared.url === "string" ? shared.url : null;
  } catch (error) {
    if (isCustomerInviteBenign(error)) return null;
    throw new SlackProvisionError("conversations.inviteShared failed", slackErrorCode(error));
  }
}

// Step 4: best-effort intro message.
export async function postIntroMessage(channelId: string, deps?: SupportClientDeps): Promise<void> {
  const client = resolveClient(deps);
  await client.chat.postMessage({
    channel: channelId,
    text: "👋 This is your private support channel with OpenCompany. Ask us anything here — we read it in real time.",
  });
}
