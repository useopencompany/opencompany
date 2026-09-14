import { createHash } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import { type SubscriptionExecute, subscriptionRows } from "@opencompany/db/session-subscriptions";
import { sql } from "drizzle-orm";
import { slackApiRequest } from "./slack";
import { slackBotScopesSatisfied } from "./slack-bot";

export const SLACK_CHANNEL_TOOL_DESCRIPTION =
  "Post a concise root message as the workspace Slack Channel bot, only when workflow instructions ask you to share work in Slack. Public channels the bot has joined only. Every post subscribes its thread to this same workflow session for 30 days. Use a stable messageKey for retries of the same intended post. Follow-up answers are delivered automatically into their original thread; do not post another root for a Slack reply.";
export const SLACK_CHANNEL_INPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    channel: { type: "string" as const, description: "Public channel ID or #name." },
    text: {
      type: "string" as const,
      description: "Concise message in Slack mrkdwn, up to 3500 characters.",
    },
    messageKey: {
      type: "string" as const,
      description: "Stable identifier for this intended post, reused on retries.",
    },
  },
  required: ["channel", "text", "messageKey"],
};
export type SlackChannelPost = { channel: string; text: string; messageKey: string };
export type ChannelInstallation = {
  id: string;
  userWorkosId: string;
  workspaceId: string;
  teamId: string;
  scopes: string[];
};

export async function channelBotCredential(installation: ChannelInstallation) {
  const credential = await loadIntegrationCredential({
    userWorkosId: installation.userWorkosId,
    integrationId: installation.id,
    provider: "slack_bot",
    kind: "oauth_token",
  });
  const token = credential?.payload.access_token;
  const botUserId = credential?.payload.bot_user_id;
  if (typeof token !== "string" || typeof botUserId !== "string")
    throw new Error("Reconnect Slack in Channels settings.");
  return { token, botUserId };
}

export async function markChannelError(installation: ChannelInstallation, error: unknown) {
  const message = error instanceof Error ? error.message : "Slack delivery failed.";
  const reauth = /invalid_auth|token_revoked|account_inactive|not_authed/.test(message);
  const missingAccess = /missing_scope|not_in_channel|channel_not_found|is_archived/.test(message);
  if (reauth || missingAccess)
    await markIntegrationStatus({
      userWorkosId: installation.userWorkosId,
      integrationId: installation.id,
      provider: "slack_bot",
      status: reauth ? "needs_reauth" : "sync_failed",
      statusReason: reauth
        ? "Reconnect the Slack Channel installation."
        : "Slack access is missing. Check the bot's channel membership and reconnect to grant required scopes.",
    });
}

export async function postWorkflowSlackMessage(
  input: { runId: string; actorId: string; post: SlackChannelPost },
  execute: SubscriptionExecute = (query) => getDb().execute(query),
) {
  const { post } = input;
  if (
    !post ||
    typeof post.channel !== "string" ||
    !post.channel.trim() ||
    typeof post.text !== "string" ||
    !post.text.trim() ||
    post.text.length > 3500 ||
    typeof post.messageKey !== "string" ||
    !post.messageKey.trim() ||
    post.messageKey.length > 100
  ) {
    throw new Error(
      "Provide channel, text (1–3500 characters), and a stable messageKey (1–100 characters).",
    );
  }
  const target = subscriptionRows<ChannelInstallation & { sessionId: string; leaseId: string }>(
    await execute(sql`
    SELECT integration.id, integration.user_workos_id AS "userWorkosId", integration.workspace_id AS "workspaceId",
      integration.external_id AS "teamId", integration.scopes, task.session_id AS "sessionId", run.lease_id AS "leaseId"
    FROM goat.codex_chat_turns run JOIN goat.tasks task ON task.session_id = run.chat_session_id
    JOIN goat.chat_sessions conversation ON conversation.id = task.session_id
    JOIN goat.integrations integration ON integration.workspace_id = task.workspace_id AND integration.provider = 'slack_bot'
    WHERE run.id = ${input.runId} AND run.user_workos_id = ${input.actorId} AND run.status = 'running'
      AND run.lease_expires_at > now() AND task.workflow_id IS NOT NULL AND task.archived_at IS NULL
      AND conversation.closed_at IS NULL AND integration.status = 'connected'
      AND EXISTS (SELECT 1 FROM goat.workspace_members member WHERE member.workspace_id = task.workspace_id AND member.user_workos_id = ${input.actorId})
  `),
  )[0];
  if (!target)
    throw new Error(
      "An active workflow session and a connected workspace Slack Channel are required.",
    );
  if (!slackBotScopesSatisfied(target.scopes))
    throw new Error("Reconnect Slack in Channels settings to grant required scopes.");
  // A continuation only answers its originating thread, via the durable outbox.
  if (
    subscriptionRows(
      await execute(
        sql`SELECT id FROM goat.subscription_events WHERE run_id = ${input.runId} LIMIT 1`,
      ),
    ).length
  ) {
    throw new Error(
      "This is a Slack follow-up. Your final answer will be sent to the original thread automatically.",
    );
  }
  const id = createHash("sha256")
    .update(`${target.sessionId}:${post.messageKey.trim()}`)
    .digest("hex");
  const text = `${post.text.trim()}\n\nReply in this thread to continue the work. Available for 30 days.`;
  const { token } = await channelBotCredential(target);
  try {
    const channelId = await resolvePublicChannel(token, post.channel.trim());
    const result = subscriptionRows<{ id: string; status: string }>(
      await execute(sql`
      INSERT INTO goat.channel_deliveries (id, workspace_id, session_id, integration_id, channel_id, text)
      SELECT ${id}, ${target.workspaceId}, ${target.sessionId}, ${target.id}, ${channelId}, ${text}
      WHERE EXISTS (SELECT 1 FROM goat.codex_chat_turns WHERE id = ${input.runId} AND status = 'running' AND lease_id = ${target.leaseId} AND lease_expires_at > now())
      ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
      WHERE channel_deliveries.text = EXCLUDED.text AND channel_deliveries.channel_id = EXCLUDED.channel_id
      RETURNING id, status
    `),
    )[0];
    if (!result)
      throw new Error("The turn is no longer active or the messageKey was used for another post.");
    return {
      deliveryId: id,
      status: result.status,
      message: "Queued for durable delivery. The thread will continue this session once posted.",
    };
  } catch (error) {
    await markChannelError(target, error);
    throw error;
  }
}

type SlackChannel = {
  id?: string;
  name?: string;
  is_member?: boolean;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_shared?: boolean;
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
  is_archived?: boolean;
};
export function isSupportedSlackChannel(channel: SlackChannel) {
  return Boolean(
    channel.id?.startsWith("C") &&
      channel.is_member &&
      !channel.is_private &&
      !channel.is_im &&
      !channel.is_mpim &&
      !channel.is_shared &&
      !channel.is_ext_shared &&
      !channel.is_pending_ext_shared &&
      !channel.is_archived,
  );
}
export async function resolvePublicChannel(token: string, requested: string): Promise<string> {
  let id = /^C[A-Z0-9]+$/.test(requested) ? requested : undefined;
  if (!id) {
    let cursor: string | undefined;
    for (let page = 0; page < 25; page++) {
      const response = await slackApiRequest<{
        channels?: SlackChannel[];
        response_metadata?: { next_cursor?: string };
      }>({
        token,
        method: "conversations.list",
        signal: AbortSignal.timeout(10_000),
        form: {
          types: "public_channel",
          exclude_archived: "true",
          limit: "200",
          ...(cursor ? { cursor } : {}),
        },
      });
      id = response.channels?.find((channel) => channel.name === requested.replace(/^#/, ""))?.id;
      cursor = response.response_metadata?.next_cursor;
      if (id || !cursor) break;
    }
  }
  if (!id)
    throw new Error(
      "Channel unavailable. Use a public channel ID or #name and invite @opencompany first.",
    );
  const response = await slackApiRequest<{ channel?: SlackChannel }>({
    token,
    method: "conversations.info",
    form: { channel: id },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.channel || !isSupportedSlackChannel(response.channel))
    throw new Error("Use a public, unshared channel that @opencompany has joined.");
  return id;
}
