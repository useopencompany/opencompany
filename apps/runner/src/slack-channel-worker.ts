import { randomUUID } from "node:crypto";
import { slackApiRequest } from "@opencompany/agent/integrations/slack";
import { slackBotCanCustomizeIdentity } from "@opencompany/agent/integrations/slack-bot";
import {
  type ChannelInstallation,
  channelBotCredential,
  markChannelError,
  resolvePublicChannel,
} from "@opencompany/agent/integrations/slack-channel";
import { TASK_WRITE_PERMISSION } from "@opencompany/core";
import {
  completeChannelDelivery,
  type SlackThreadReply,
  type SubscriptionExecute,
  subscriptionRows,
} from "@opencompany/db/session-subscriptions";
import { PostgresTaskRepository } from "@opencompany/db/task-repository";
import { createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { createPollingWorker } from "./polling-worker";

const logger = createLogger({ service: "opencompany-runner", runtime: "slack-channel" });
const CLOSED_REPLY =
  "This workflow thread is closed. Open the task in opencompany to continue the work.";
const UNANSWERED_REPLY =
  "The workflow needs attention. Open the task in opencompany to review and continue.";
const MAX_SLACK_THREAD_CONTEXT_CHARS = 100_000;

type Event = {
  id: number;
  subscriptionId: string;
  workspaceId: string;
  sessionId: string;
  taskId: string;
  ownerId: string;
  payload: SlackThreadReply;
  status: string;
  runId: string | null;
  closed: boolean;
  runStatus: string | null;
  botDisplayName: string;
  installation: ChannelInstallation;
};
type SlackUser = {
  id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: {
    display_name?: string;
    display_name_normalized?: string;
    real_name?: string;
    real_name_normalized?: string;
    email?: string;
  };
};
type SlackThreadMessage = {
  user?: string;
  username?: string;
  text?: string;
};
type Transaction = { execute: SubscriptionExecute };
export type SlackChannelWorkerDependencies = {
  db: {
    transaction: <T>(body: (tx: Transaction) => Promise<T>) => Promise<T>;
    execute: SubscriptionExecute;
  };
  credential: typeof channelBotCredential;
  request: typeof slackApiRequest;
  validateChannel: typeof resolvePublicChannel;
};
const defaults = (): SlackChannelWorkerDependencies => ({
  db: getDb(),
  credential: channelBotCredential,
  request: slackApiRequest,
  validateChannel: resolvePublicChannel,
});

export async function processNextSubscriptionEvent(deps = defaults()): Promise<boolean> {
  let claimed: Event | undefined;
  try {
    return await deps.db.transaction(async (tx) => {
      const event = subscriptionRows<Event>(
        await tx.execute(sql`
      SELECT event.id, event.subscription_id AS "subscriptionId", subscription.workspace_id AS "workspaceId",
        subscription.session_id AS "sessionId", task.id AS "taskId", task.user_workos_id AS "ownerId", event.payload, event.status, event.run_id AS "runId",
        (subscription.status = 'closed' OR subscription.expires_at <= now() OR task.archived_at IS NOT NULL
          OR conversation.closed_at IS NOT NULL
          -- Turning Slack off or retiring the workflow closes its open threads too. Without this
          -- the reply would start a run that has no way to answer, and the person waiting in Slack
          -- would get the generic "needs attention" notice instead of a closed thread.
          OR workflow.id IS NULL OR workflow.slack_channel_enabled IS FALSE) AS closed,
        run.status AS "runStatus",
        COALESCE(workflow.slack_bot_display_name, '') AS "botDisplayName",
        jsonb_build_object('id', integration.id, 'workspaceId', integration.workspace_id,
          'userWorkosId', integration.user_workos_id, 'teamId', integration.external_id, 'scopes', integration.scopes) AS installation
      FROM goat.subscription_events event
      JOIN goat.session_subscriptions subscription ON subscription.id = event.subscription_id
      JOIN goat.tasks task ON task.session_id = subscription.session_id AND task.workspace_id = subscription.workspace_id
      -- workflow_id is a slug; the time fence prevents a later workflow reusing it from taking
      -- authority over this historical Task and its Slack thread.
      LEFT JOIN goat.workflows workflow ON workflow.workspace_id = task.workspace_id
        AND workflow.slug = task.workflow_id AND workflow.archived_at IS NULL
        AND workflow.created_at <= task.created_at
      JOIN goat.chat_sessions conversation ON conversation.id = task.session_id
      JOIN goat.integrations integration ON integration.id = subscription.integration_id AND integration.workspace_id = subscription.workspace_id
        AND integration.external_id = subscription.source_key->>'teamId'
      LEFT JOIN goat.codex_chat_turns run ON run.id = event.run_id
      WHERE event.status IN ('pending', 'running', 'delivering') AND event.next_attempt_at <= now() AND integration.status = 'connected'
        AND NOT EXISTS (
          SELECT 1 FROM goat.subscription_events earlier
          JOIN goat.session_subscriptions earlier_subscription ON earlier_subscription.id = earlier.subscription_id
          WHERE earlier_subscription.session_id = subscription.session_id AND earlier.id < event.id
            AND earlier.status NOT IN ('done', 'ignored')
        )
        AND ((event.status = 'delivering' AND EXISTS (SELECT 1 FROM goat.channel_deliveries delivery WHERE delivery.id = 'subscription_reply_' || event.id::text AND delivery.status IN ('sent', 'canceled'))) OR (
          task.status IN ('waiting', 'succeeded', 'failed', 'canceled') AND NOT EXISTS (
            SELECT 1 FROM goat.codex_chat_turns active WHERE active.chat_session_id = subscription.session_id
              AND active.status IN ('queued', 'running', 'paused')
          )
        ))
      ORDER BY event.id FOR UPDATE OF task, event SKIP LOCKED LIMIT 1
    `),
      )[0];
      if (!event) return false;
      claimed = event;
      const deliveryId = `subscription_reply_${event.id}`;
      if (event.status === "delivering") {
        const sent = subscriptionRows(
          await tx.execute(
            sql`SELECT id FROM goat.channel_deliveries WHERE id = ${deliveryId} AND status IN ('sent', 'canceled')`,
          ),
        ).length;
        if (sent)
          await tx.execute(
            sql`UPDATE goat.subscription_events SET status = 'done' WHERE id = ${event.id}`,
          );
        return Boolean(sent);
      }
      if (event.status === "running") {
        if (!event.runStatus || !["completed", "failed", "interrupted"].includes(event.runStatus))
          return false;
        // Slack replies are explicit tool actions. A completed turn that did not use the tool
        // must not leak its task-facing assistant message into the external thread. A turn that
        // never got to answer is different: the fixed notice carries no task content, and without
        // it the person who asked in Slack is left waiting on a reply that will never come.
        if (event.runStatus === "completed") {
          await tx.execute(
            sql`UPDATE goat.subscription_events SET status = 'done' WHERE id = ${event.id} AND status = 'running'`,
          );
          return true;
        }
        await queueReply(tx.execute.bind(tx), event, deliveryId, UNANSWERED_REPLY);
        return true;
      }
      const { token, botUserId } = await deps.credential(event.installation);
      if (event.payload.slackUserId === botUserId) {
        await ignoreEvent(tx.execute.bind(tx), event.id);
        return true;
      }
      await deps.validateChannel(token, event.payload.channelId);
      const user = await deps.request<{ user?: SlackUser }>({
        method: "users.info",
        token,
        form: { user: event.payload.slackUserId },
        signal: AbortSignal.timeout(10_000),
      });
      if (user.user?.id !== event.payload.slackUserId || user.user.is_bot || user.user.deleted) {
        await ignoreEvent(tx.execute.bind(tx), event.id);
        return true;
      }
      const thread = await readSlackThread({
        token,
        channelId: event.payload.channelId,
        threadTs: event.payload.threadTs,
        request: deps.request,
      });
      // Publishing the workflow thread lets its Slack participants continue the owner's work.
      // The sender is attributed in the prompt; execution keeps the owner's existing authority.
      const [owner] = subscriptionRows<{ userId: string; role: "admin" | "member" }>(
        await tx.execute(sql`
      SELECT user_workos_id AS "userId", role FROM goat.workspace_members
      WHERE workspace_id = ${event.workspaceId} AND user_workos_id = ${event.ownerId}
    `),
      );
      if (event.closed || !owner) {
        await tx.execute(
          sql`UPDATE goat.session_subscriptions SET status = 'closed' WHERE id = ${event.subscriptionId}`,
        );
        await queueReply(tx.execute.bind(tx), event, deliveryId, CLOSED_REPLY);
        return true;
      }
      // Task, runtime, Messages and Run commit with the inbox cursor. A worker crash cannot
      // turn the same event into another Run. The existing runner owns the fenced Run lease.
      const result = await new PostgresTaskRepository(tx.execute.bind(tx)).createTaskCommentAndRun({
        actor: {
          userId: owner.userId,
          workspaceId: event.workspaceId,
          role: owner.role,
          permissions: [TASK_WRITE_PERMISSION],
          authenticationMethod: "service",
        },
        taskId: event.taskId,
        command: {
          id: `subscription_event_${event.id}`,
          body: slackFollowUpPrompt({
            eventId: event.id,
            slackUserId: event.payload.slackUserId,
            text: event.payload.text,
            user: user.user,
            botUserId,
            thread,
          }),
        },
      });
      if (!result) throw new Error("The subscribed task could not be resumed.");
      await tx.execute(
        sql`UPDATE goat.subscription_events SET status = 'running', run_id = ${result.runId} WHERE id = ${event.id}`,
      );
      return true;
    });
  } catch (error) {
    if (claimed) {
      await deps.db.execute(
        sql`UPDATE goat.subscription_events SET next_attempt_at = now() + interval '1 minute' WHERE id = ${claimed.id} AND status = ${claimed.status}`,
      );
      await markChannelError(claimed.installation, error);
    }
    throw error;
  }
}
async function readSlackThread(input: {
  token: string;
  channelId: string;
  threadTs: string;
  request: typeof slackApiRequest;
}) {
  const messages: SlackThreadMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const response = await input.request<{
      messages?: SlackThreadMessage[];
      response_metadata?: { next_cursor?: string };
    }>({
      method: "conversations.replies",
      token: input.token,
      form: {
        channel: input.channelId,
        ts: input.threadTs,
        limit: "200",
        ...(cursor ? { cursor } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.messages) messages.push(...response.messages);
    cursor = response.response_metadata?.next_cursor?.trim() || undefined;
    if (!cursor) return { messages, truncated: false };
  }
  return { messages, truncated: Boolean(cursor) };
}

export function slackFollowUpPrompt(input: {
  eventId: number;
  slackUserId: string;
  text: string;
  user: SlackUser;
  botUserId: string;
  thread: { messages: SlackThreadMessage[]; truncated: boolean };
}) {
  const name = slackUserName(input.user, input.slackUserId);
  const email = compactSlackProfileField(input.user.profile?.email);
  const sender = `${name}${email ? ` <${email}>` : ""} (Slack user ${input.slackUserId})`;
  const messages: string[] = [];
  let contextLength = 0;
  let contentTruncated = false;
  for (const message of input.thread.messages) {
    const author =
      message.user === input.slackUserId
        ? sender
        : message.user === input.botUserId
          ? `opencompany bot (Slack user ${input.botUserId})`
          : message.user
            ? `Slack user ${message.user}`
            : compactSlackProfileField(message.username) || "Slack app";
    const formatted = `${author}:\n${quoteSlackText(message.text ?? "")}`;
    if (contextLength + formatted.length > MAX_SLACK_THREAD_CONTEXT_CHARS) {
      contentTruncated = true;
      break;
    }
    messages.push(formatted);
    contextLength += formatted.length;
  }
  if (input.thread.truncated || contentTruncated)
    messages.push("[Additional Slack thread context was omitted because the thread is very long.]");
  return `Slack thread follow-up\n\nSender: ${sender}\n\nContinue this same workflow using its saved context and artifacts. The full Slack thread so far is included as context below. Do not create another task or a root Slack message.\n\nBefore writing your final task answer, call post_slack_message with your final Slack reply as text and \"slack-follow-up-${input.eventId}\" as messageKey. Omit channel so the tool posts to the originating thread. The assistant turn itself is not sent to Slack.\n\n--- Full Slack thread ---\n${messages.join("\n\n")}\n--- End Slack thread ---\n\n--- New follow-up message begins ---\nFrom: ${sender}\n${quoteSlackText(input.text)}\n--- New follow-up message ends ---`;
}

function slackUserName(user: SlackUser, fallbackId: string) {
  return (
    compactSlackProfileField(user.profile?.display_name_normalized) ||
    compactSlackProfileField(user.profile?.display_name) ||
    compactSlackProfileField(user.profile?.real_name_normalized) ||
    compactSlackProfileField(user.profile?.real_name) ||
    compactSlackProfileField(user.real_name) ||
    compactSlackProfileField(user.name) ||
    fallbackId
  );
}

function compactSlackProfileField(value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim() || "";
}

function quoteSlackText(text: string) {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
async function ignoreEvent(execute: SubscriptionExecute, id: number) {
  await execute(sql`UPDATE goat.subscription_events SET status = 'ignored' WHERE id = ${id}`);
}
async function queueReply(execute: SubscriptionExecute, event: Event, id: string, text: string) {
  // One Slack response per turn. Long results stay in the durable task transcript.
  const concise =
    text.length > 3500
      ? `${text.slice(0, 3450)}\n\nFull result is available in the opencompany task.`
      : text;
  await execute(sql`INSERT INTO goat.channel_deliveries (id, workspace_id, session_id, integration_id, team_id, channel_id, thread_ts, text, bot_display_name)
    VALUES (${id}, ${event.workspaceId}, ${event.sessionId}, ${event.installation.id}, ${event.payload.teamId}, ${event.payload.channelId}, ${event.payload.threadTs}, ${concise}, ${event.botDisplayName}) ON CONFLICT DO NOTHING`);
  await execute(
    sql`UPDATE goat.subscription_events SET status = 'delivering' WHERE id = ${event.id}`,
  );
}

type Delivery = {
  id: string;
  channelId: string;
  threadTs: string | null;
  text: string;
  botDisplayName: string;
  status: string;
  createdAt: Date;
  leaseId: string;
  installation: ChannelInstallation;
};
export async function processNextChannelDelivery(deps = defaults()): Promise<boolean> {
  const leaseId = randomUUID();
  const delivery = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE goat.channel_deliveries delivery SET status = 'canceled', error = NULL
      WHERE delivery.status = 'pending' AND (
        NOT EXISTS (SELECT 1 FROM goat.integrations integration WHERE integration.id = delivery.integration_id AND integration.external_id = delivery.team_id)
        OR (delivery.thread_ts IS NULL AND (delivery.created_at <= now() - interval '30 days'
          OR EXISTS (SELECT 1 FROM goat.tasks task WHERE task.session_id = delivery.session_id AND task.archived_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM goat.chat_sessions conversation WHERE conversation.id = delivery.session_id AND conversation.closed_at IS NOT NULL)))
      )`);
    const row = subscriptionRows<Delivery>(
      await tx.execute(sql`
      SELECT delivery.id, delivery.channel_id AS "channelId", delivery.thread_ts AS "threadTs", delivery.text,
        delivery.bot_display_name AS "botDisplayName", delivery.status, delivery.created_at AS "createdAt",
        jsonb_build_object('id', integration.id, 'workspaceId', integration.workspace_id,
          'userWorkosId', integration.user_workos_id, 'teamId', integration.external_id, 'scopes', integration.scopes) AS installation
      FROM goat.channel_deliveries delivery JOIN goat.integrations integration ON integration.id = delivery.integration_id AND integration.external_id = delivery.team_id
      WHERE integration.status = 'connected' AND ((delivery.status = 'pending' AND (delivery.lease_expires_at IS NULL OR delivery.lease_expires_at < now())) OR (
        delivery.status IN ('sending', 'uncertain') AND delivery.lease_expires_at < now()))
      ORDER BY delivery.created_at FOR UPDATE OF delivery, integration SKIP LOCKED LIMIT 1
    `),
    )[0];
    if (!row) return null;
    await tx.execute(
      sql`UPDATE goat.channel_deliveries SET status = 'sending', lease_id = ${leaseId}, lease_expires_at = now() + interval '2 minutes' WHERE id = ${row.id}`,
    );
    return { ...row, leaseId };
  });
  if (!delivery) return false;
  const execute = deps.db.execute.bind(deps.db);
  let postAttempted = delivery.status !== "pending";
  try {
    const { token, botUserId } = await deps.credential(delivery.installation);
    const canCustomizeIdentity = slackBotCanCustomizeIdentity(delivery.installation.scopes);
    await deps.validateChannel(token, delivery.channelId);
    let messageTs: string | null = null;
    if (delivery.status === "pending") {
      postAttempted = true;
      const response = await deps.request<{ ts?: string }>({
        token,
        method: "chat.postMessage",
        signal: AbortSignal.timeout(15_000),
        form: {
          channel: delivery.channelId,
          text: delivery.text,
          ...(delivery.threadTs ? { thread_ts: delivery.threadTs } : {}),
          // An install that predates chat:write.customize keeps posting under the default bot
          // identity: a cosmetic name is never worth failing the delivery over.
          ...(delivery.botDisplayName && canCustomizeIdentity
            ? { username: delivery.botDisplayName }
            : {}),
          metadata: JSON.stringify({
            event_type: "opencompany_delivery",
            event_payload: { delivery_id: delivery.id },
          }),
          unfurl_links: "false",
          unfurl_media: "false",
        },
      });
      messageTs = typeof response.ts === "string" ? response.ts : null;
      if (!messageTs)
        throw new Error("Slack returned no message timestamp; delivery outcome is uncertain.");
    } else {
      messageTs = await reconcileChannelDelivery(delivery, token, botUserId, deps.request);
    }
    if (messageTs) {
      await completeChannelDelivery(execute, {
        id: delivery.id,
        teamId: delivery.installation.teamId,
        channelId: delivery.channelId,
        threadTs: delivery.threadTs,
        messageTs,
      });
    } else {
      await uncertainDelivery(
        execute,
        delivery,
        "Slack delivery could not be confirmed. It has not been reposted.",
      );
    }
  } catch (error) {
    if (postAttempted) {
      await uncertainDelivery(
        execute,
        delivery,
        "Slack delivery needs attention. It has not been reposted.",
      );
    } else {
      // No external write was attempted; retrying this preflight is safe.
      await execute(sql`UPDATE goat.channel_deliveries SET status = 'pending', lease_expires_at = now() + interval '1 minute'
        WHERE id = ${delivery.id} AND lease_id = ${delivery.leaseId} AND status = 'sending'`);
    }
    await markChannelError(delivery.installation, error);
    logger.warn("Slack Channel delivery requires reconciliation", { delivery_id: delivery.id });
  }
  return true;
}
async function uncertainDelivery(execute: SubscriptionExecute, delivery: Delivery, error: string) {
  await execute(sql`UPDATE goat.channel_deliveries SET status = 'uncertain', error = ${error}, lease_expires_at = now() + interval '15 minutes'
    WHERE id = ${delivery.id} AND lease_id = ${delivery.leaseId} AND status = 'sending'`);
}
export async function reconcileChannelDelivery(
  delivery: Pick<Delivery, "id" | "channelId" | "threadTs" | "createdAt">,
  token: string,
  botUserId: string,
  request = slackApiRequest,
): Promise<string | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = await request<{
      messages?: Array<{
        user?: string;
        bot_id?: string;
        ts?: string;
        metadata?: { event_type?: string; event_payload?: { delivery_id?: string } };
      }>;
      response_metadata?: { next_cursor?: string };
    }>({
      token,
      method: delivery.threadTs ? "conversations.replies" : "conversations.history",
      signal: AbortSignal.timeout(10_000),
      form: {
        channel: delivery.channelId,
        ...(delivery.threadTs ? { ts: delivery.threadTs } : {}),
        oldest: String(new Date(delivery.createdAt).getTime() / 1000 - 60),
        include_all_metadata: "true",
        limit: "100",
        ...(cursor ? { cursor } : {}),
      },
    });
    // A post that overrides the workflow's display name arrives back as a bot_message with no
    // `user`, so authorship is checked as "our bot user, or some app" and the delivery id in our
    // own metadata — unique per post — is what actually identifies the message.
    const found = response.messages?.find(
      (message) =>
        (message.user === botUserId || Boolean(message.bot_id)) &&
        message.metadata?.event_type === "opencompany_delivery" &&
        message.metadata.event_payload?.delivery_id === delivery.id,
    );
    if (found?.ts) return found.ts;
    cursor = response.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  // Absence in history is not proof that a timed-out post failed. Never blindly resend.
  return null;
}

export function startSlackChannelWorker(onRunQueued: () => void) {
  return createPollingWorker({
    pollIntervalMs: 2_000,
    poll: async () => {
      const deps = defaults();
      await deps.db.execute(
        sql`UPDATE goat.session_subscriptions SET status = 'closed' WHERE status = 'waiting' AND expires_at <= now()`,
      );
      const event = await processNextSubscriptionEvent(deps).catch((error) => {
        logger.warn("Slack reply deferred", {
          error_message: error instanceof Error ? error.message : "Unknown error",
        });
        return false;
      });
      if (event) onRunQueued();
      const delivery = await processNextChannelDelivery(deps);
      return event || delivery;
    },
    onError: (error) =>
      logger.error("Slack Channel worker failed", {
        error_message: error instanceof Error ? error.message : "Unknown error",
      }),
  });
}
