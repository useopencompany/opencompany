import { type SQL, sql } from "drizzle-orm";

export type SubscriptionExecute = (query: SQL) => Promise<unknown>;
export function subscriptionRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: T[] })?.rows) ?? [];
}

export type SlackThreadReply = {
  teamId: string;
  eventId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  slackUserId: string;
  text: string;
  files?: Array<{
    id: string;
    name: string;
    mediaType: string;
    sizeBytes: number;
    urlPrivateDownload: string;
  }>;
  integrationId?: string;
};

// Ingress does no provider calls. Persist first; authorize the sender again at consumption.
// The subscription lock defines accepted order, including simultaneous webhook deliveries.
export async function enqueueSlackThreadReply(
  execute: SubscriptionExecute,
  event: SlackThreadReply,
) {
  const sourceKey = JSON.stringify({
    teamId: event.teamId,
    channelId: event.channelId,
    threadTs: event.threadTs,
  });
  return subscriptionRows(
    await execute(sql`
    WITH locked AS MATERIALIZED (
      SELECT subscription.id FROM goat.session_subscriptions subscription
      JOIN goat.integrations integration ON integration.id = subscription.integration_id
      JOIN goat.chat_sessions conversation ON conversation.id = subscription.session_id
      WHERE subscription.source = 'slack_thread' AND subscription.source_key @> ${sourceKey}::jsonb
        AND integration.provider = 'slack_bot' AND integration.external_id = ${event.teamId}
        AND (${event.integrationId ?? null}::text IS NOT NULL AND integration.id = ${event.integrationId ?? null}
          OR ${event.integrationId ?? null}::text IS NULL AND integration.company_agent_id IS NULL)
        AND integration.workspace_id = subscription.workspace_id AND integration.status = 'connected'
      ORDER BY conversation.id, subscription.id FOR UPDATE OF conversation, subscription
    ), sequenced AS (
      UPDATE goat.session_subscriptions subscription SET next_sequence = next_sequence + 1
      FROM locked WHERE subscription.id = locked.id
      RETURNING subscription.id, subscription.next_sequence
    )
    INSERT INTO goat.subscription_events (subscription_id, event_id, sequence, payload)
    SELECT id, ${event.eventId}, next_sequence, ${JSON.stringify(event)}::jsonb FROM sequenced
    ON CONFLICT (subscription_id, event_id) DO NOTHING RETURNING id
  `),
  ).length;
}

// A successful post and its subscription commit together. The ID is also the Slack metadata
// key, allowing history reconciliation to repair an ambiguous HTTP result.
export async function completeChannelDelivery(
  execute: SubscriptionExecute,
  input: {
    id: string;
    teamId: string;
    channelId: string;
    threadTs: string | null;
    messageTs: string;
  },
) {
  await execute(sql`
    WITH installation AS MATERIALIZED (
      SELECT id, status, company_agent_id FROM goat.integrations WHERE external_id = ${input.teamId} AND provider = 'slack_bot'
      FOR SHARE
    ), delivered AS (
      UPDATE goat.channel_deliveries delivery SET status = 'sent', message_ts = ${input.messageTs},
        lease_id = NULL, lease_expires_at = NULL, error = NULL
      FROM installation integration
      WHERE delivery.id = ${input.id} AND delivery.integration_id = integration.id
        AND delivery.team_id = ${input.teamId}
        AND delivery.channel_id = ${input.channelId}
        AND delivery.thread_ts IS NOT DISTINCT FROM ${input.threadTs}::text
        AND delivery.status IN ('sending', 'uncertain', 'sent')
      RETURNING delivery.*, integration.status AS installation_status, integration.company_agent_id
    )
    INSERT INTO goat.session_subscriptions
      (id, workspace_id, session_id, integration_id, source, source_key, expires_at, status)
    SELECT id, workspace_id, session_id, integration_id, 'slack_thread',
      jsonb_build_object('teamId', ${input.teamId}::text, 'channelId', channel_id, 'threadTs', message_ts)
        || CASE WHEN company_agent_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('integrationId', integration_id) END,
      created_at + interval '30 days', CASE WHEN installation_status = 'connected' AND created_at > now() - interval '30 days'
        AND NOT EXISTS (SELECT 1 FROM goat.tasks task WHERE task.session_id = delivered.session_id AND task.archived_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM goat.chat_sessions conversation WHERE conversation.id = delivered.session_id AND conversation.closed_at IS NOT NULL)
        THEN 'waiting' ELSE 'closed' END
    FROM delivered WHERE thread_ts IS NULL
    ON CONFLICT DO NOTHING
  `);
}

export type SlackDirectMessage = {
  teamId: string;
  eventId: string;
  channelId: string;
  messageTs: string;
  slackUserId: string;
  text: string;
};

// A direct message has no subscription to attach to yet: it is the request to open one. Ingress
// persists it as-is and the runner resolves the sender and creates the Task.
export async function enqueueSlackDirectMessage(
  execute: SubscriptionExecute,
  message: SlackDirectMessage,
) {
  return subscriptionRows(
    await execute(sql`
    INSERT INTO goat.slack_direct_messages (team_id, event_id, channel_id, message_ts, slack_user_id, text)
    SELECT ${message.teamId}, ${message.eventId}, ${message.channelId}, ${message.messageTs},
      ${message.slackUserId}, ${message.text}
    WHERE EXISTS (
      SELECT 1 FROM goat.integrations
      WHERE provider = 'slack_bot' AND company_agent_id IS NULL AND external_id = ${message.teamId} AND status = 'connected'
    )
    ON CONFLICT (team_id, event_id) DO NOTHING RETURNING id
  `),
  ).length;
}
