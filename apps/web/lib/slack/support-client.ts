import { createHash } from "node:crypto";
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
    list: (args: {
      types?: string;
      exclude_archived?: boolean;
      limit?: number;
      cursor?: string | undefined;
    }) => Promise<{
      channels?: Array<{ id?: string; name?: string }>;
      response_metadata?: { next_cursor?: string };
    }>;
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

// A per-workspace channel-name suffix derived deterministically from the workspace id.
// Baking it into the name from the start makes the name unique per workspace (no
// cross-workspace collisions) AND makes a `name_taken` on retry unambiguous: it can only
// be THIS workspace's own channel from an earlier attempt, so adopting it is safe.
// sha256 (not the raw id tail) gives uniform distribution regardless of id format.
function channelSuffix(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 6);
}

// The deterministic Slack channel name for a workspace's support channel.
export function supportChannelName(workspace: { id: string; name: string }): string {
  return channelName(workspaceChannelSlug(workspace.name), channelSuffix(workspace.id));
}

// Find a private channel by exact name (paginated). Used to ADOPT the channel a prior
// provisioning attempt created but never persisted (process died between Slack's create
// response and setSlackChannelId). Requires the `groups:read` bot scope.
async function findChannelIdByName(
  client: SlackProvisionClient,
  name: string,
): Promise<string | null> {
  let cursor: string | undefined;
  do {
    const res = await client.conversations.list({
      types: "private_channel",
      exclude_archived: false,
      limit: 200,
      cursor,
    });
    const match = res.channels?.find((channel) => channel.name === name);
    if (match?.id) return match.id;
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return null;
}

// Step 1 of provisioning: create the workspace's private support channel. The name is
// unique per workspace (slug + id-derived suffix), so a `name_taken` can only mean a
// prior attempt already created it (its id wasn't persisted before a crash). In that
// case we ADOPT the existing channel instead of minting a second (orphaned) one — this
// is what keeps "exactly one channel per workspace" true even across a mid-create crash.
export async function createSupportChannel(
  workspace: { id: string; name: string },
  deps?: SupportClientDeps,
): Promise<string> {
  const client = resolveClient(deps);
  const name = supportChannelName(workspace);

  try {
    const created = await client.conversations.create({ name, is_private: true });
    const id = created.channel?.id;
    if (!id) throw new SlackProvisionError("conversations.create returned no channel id");
    return id;
  } catch (error) {
    if (error instanceof SlackProvisionError) throw error;
    if (slackErrorCode(error) !== "name_taken") {
      throw new SlackProvisionError("conversations.create failed", slackErrorCode(error));
    }
    // name_taken on our workspace-unique name → adopt the channel a prior attempt left.
    const existingId = await findChannelIdByName(client, name);
    if (!existingId) {
      throw new SlackProvisionError(
        "conversations.create reported name_taken but the channel was not found",
        "name_taken",
      );
    }
    return existingId;
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
