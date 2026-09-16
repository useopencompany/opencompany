import { createHash } from "node:crypto";
import { getDb } from "@opencompany/db/client";
import { loadIntegrationCredential, markIntegrationStatus } from "@opencompany/db/integrations";
import { type SubscriptionExecute, subscriptionRows } from "@opencompany/db/session-subscriptions";
import { sql } from "drizzle-orm";
import { slackApiRequest } from "./slack";
import { slackBotDeliveryScopesSatisfied } from "./slack-bot";

export const SLACK_CHANNEL_TOOL_DESCRIPTION =
  "Send a message as the opencompany Slack bot: the shared workspace bot, not any member's personal Slack plugin. This is the tool for instructions that ask to post, send, or share something in Slack with the opencompany Slack bot, and it should only be used when they ask. For a Slack follow-up, omit channel and the message goes to the originating thread. Otherwise channel is required and must be a public channel the bot has joined; that post subscribes its thread to this same workflow session for 30 days. Use a stable messageKey for retries of the same intended post.";
export const SLACK_CHANNEL_INPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    channel: {
      type: "string" as const,
      description: "Public channel ID or #name. Required when starting a new Slack thread.",
    },
    text: {
      type: "string" as const,
      description: "Concise message in Slack mrkdwn, up to 3500 characters.",
    },
    messageKey: {
      type: "string" as const,
      description: "Stable identifier for this intended post, reused on retries.",
    },
  },
  required: ["text", "messageKey"],
};
export type SlackChannelPost = { channel?: string; text: string; messageKey: string };
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
    typeof post.text !== "string" ||
    !post.text.trim() ||
    post.text.length > 3500 ||
    typeof post.messageKey !== "string" ||
    !post.messageKey.trim() ||
    post.messageKey.length > 100
  ) {
    throw new Error("Provide text (1–3500 characters) and a stable messageKey (1–100 characters).");
  }
  // workflow_id is the workspace-scoped slug. Match the live workflow that existed when this Task
  // was created so an archived Task cannot inherit a replacement workflow's Slack authority.
  const target = subscriptionRows<
    ChannelInstallation & {
      sessionId: string;
      leaseId: string;
      botDisplayName: string;
      botAvatarUrl: string;
      subscriptionEventId: number | null;
      followUpChannelId: string | null;
      followUpThreadTs: string | null;
    }
  >(
    await execute(sql`
    SELECT integration.id, integration.user_workos_id AS "userWorkosId", integration.workspace_id AS "workspaceId",
      integration.external_id AS "teamId", integration.scopes, task.session_id AS "sessionId", run.lease_id AS "leaseId",
      workflow.slack_bot_display_name AS "botDisplayName",
      workflow.slack_bot_avatar_url AS "botAvatarUrl",
      event.id AS "subscriptionEventId", subscription.source_key->>'channelId' AS "followUpChannelId",
      subscription.source_key->>'threadTs' AS "followUpThreadTs"
    FROM goat.codex_chat_turns run JOIN goat.tasks task ON task.session_id = run.chat_session_id
    JOIN goat.workflows workflow ON workflow.workspace_id = task.workspace_id
      AND workflow.slug = task.workflow_id AND workflow.archived_at IS NULL
      AND workflow.created_at <= task.created_at
    JOIN goat.chat_sessions conversation ON conversation.id = task.session_id
    JOIN goat.integrations integration ON integration.workspace_id = task.workspace_id AND integration.provider = 'slack_bot'
    LEFT JOIN goat.subscription_events event ON event.run_id = run.id AND event.status IN ('running', 'delivering')
    LEFT JOIN goat.session_subscriptions subscription ON subscription.id = event.subscription_id
      AND subscription.integration_id = integration.id AND subscription.source = 'slack_thread'
    WHERE run.id = ${input.runId} AND run.user_workos_id = ${input.actorId} AND run.status = 'running'
      AND run.lease_expires_at > now() AND task.archived_at IS NULL
      AND workflow.slack_channel_enabled AND conversation.closed_at IS NULL AND integration.status = 'connected'
      AND EXISTS (SELECT 1 FROM goat.workspace_members member WHERE member.workspace_id = task.workspace_id AND member.user_workos_id = ${input.actorId})
  `),
  )[0];
  if (!target)
    throw new Error(
      "An active workflow session with its Slack channel enabled and a connected workspace Slack Channel are required.",
    );
  if (!slackBotDeliveryScopesSatisfied(target.scopes))
    throw new Error("Reconnect Slack in Channels settings to grant required scopes.");
  const text = post.text.trim();
  if (target.subscriptionEventId !== null) {
    if (!target.followUpChannelId || !target.followUpThreadTs) {
      throw new Error("The originating Slack thread is unavailable.");
    }
    const deliveryId = `subscription_reply_${target.subscriptionEventId}`;
    const result = subscriptionRows<{ id: string; status: string }>(
      await execute(sql`
      WITH active AS MATERIALIZED (
        SELECT event.id
        FROM goat.subscription_events event
        JOIN goat.codex_chat_turns run ON run.id = event.run_id
        WHERE event.id = ${target.subscriptionEventId} AND event.run_id = ${input.runId}
          AND event.status IN ('running', 'delivering') AND run.status = 'running'
          AND run.lease_id = ${target.leaseId} AND run.lease_expires_at > now()
        FOR SHARE OF event, run
      ), delivery AS MATERIALIZED (
        INSERT INTO goat.channel_deliveries
          (id, workspace_id, session_id, integration_id, team_id, channel_id, thread_ts, text, bot_display_name, bot_avatar_url)
        SELECT ${deliveryId}, ${target.workspaceId}, ${target.sessionId}, ${target.id}, ${target.teamId},
          ${target.followUpChannelId}, ${target.followUpThreadTs}, ${text}, ${target.botDisplayName}, ${target.botAvatarUrl}
        FROM active
        ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
        WHERE channel_deliveries.text = EXCLUDED.text
          AND channel_deliveries.channel_id = EXCLUDED.channel_id
          AND channel_deliveries.thread_ts IS NOT DISTINCT FROM EXCLUDED.thread_ts
        RETURNING id, status
      ), marked AS (
        UPDATE goat.subscription_events event SET status = 'delivering'
        FROM active, delivery
        WHERE event.id = active.id AND event.status IN ('running', 'delivering')
        RETURNING event.id
      )
      SELECT delivery.id, delivery.status FROM delivery JOIN marked ON true
    `),
    )[0];
    if (!result)
      throw new Error(
        "The turn is no longer active or this Slack follow-up already has a different reply.",
      );
    return {
      deliveryId,
      status: result.status,
      message: "Queued for durable delivery to the originating Slack thread.",
    };
  }
  if (typeof post.channel !== "string" || !post.channel.trim())
    throw new Error("Provide channel when starting a new Slack thread.");
  const id = createHash("sha256")
    .update(`${target.sessionId}:${post.messageKey.trim()}`)
    .digest("hex");
  const { token } = await channelBotCredential(target);
  try {
    const channelId = await resolvePublicChannel(token, post.channel.trim());
    const result = subscriptionRows<{ id: string; status: string }>(
      await execute(sql`
      WITH connected AS MATERIALIZED (
        SELECT id FROM goat.integrations WHERE id = ${target.id} AND status = 'connected' AND external_id = ${target.teamId} FOR SHARE
      )
      INSERT INTO goat.channel_deliveries (id, workspace_id, session_id, integration_id, team_id, channel_id, text, bot_display_name, bot_avatar_url)
      SELECT ${id}, ${target.workspaceId}, ${target.sessionId}, ${target.id}, ${target.teamId}, ${channelId}, ${text}, ${target.botDisplayName}, ${target.botAvatarUrl}
      FROM connected
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
  if (response.channel?.id !== id || !isSupportedSlackChannel(response.channel))
    throw new Error("Use a public, unshared channel that @opencompany has joined.");
  return id;
}
