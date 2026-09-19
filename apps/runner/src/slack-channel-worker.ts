import { randomUUID } from "node:crypto";
import { SLACK_BOT_TOOL_NAME } from "@opencompany/agent/chat-ui";
import { slackApiRequest } from "@opencompany/agent/integrations/slack";
import {
  slackBotCanCustomizeIdentity,
  slackBotCanReact,
} from "@opencompany/agent/integrations/slack-bot";
import {
  type ChannelInstallation,
  channelBotCredential,
  markChannelError,
  resolvePublicChannel,
} from "@opencompany/agent/integrations/slack-channel";
import { processNextSlackProvisioning } from "@opencompany/agent/integrations/slack-provisioning";
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
import { processNextSlackAgentMessage } from "./slack-agent-worker";
import { processNextSlackDirectMessage } from "./slack-direct-message-worker";

const logger = createLogger({ service: "opencompany-runner", runtime: "slack-channel" });
const CLOSED_REPLY = "This thread is closed. Open the task in opencompany to continue the work.";
const UNANSWERED_REPLY =
  "This needs attention. Open the task in opencompany to review and continue.";
const MAX_SLACK_THREAD_CONTEXT_CHARS = 100_000;
// Progress on a Slack reply is worker state, so the worker marks it: the person who asked sees the
// ack on their own message instead of an extra post in the channel. Deliberately not a tool the run
// calls - that would need its own instructions, would only fire once the model already decided to,
// and would stay silent in exactly the case that needs a signal most: a run that dies unanswered.
export const REACTION_WORKING = "eyes";
const REACTION_ANSWERED = "white_check_mark";
const REACTION_ATTENTION = "warning";

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
  botAvatarUrl: string;
  installation: ChannelInstallation;
};
export type SlackUser = {
  id?: string;
  team_id?: string;
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
  // Set inside the transaction, applied after it commits: a rolled-back claim must not leave a
  // mark for a run that never started.
  let reaction: string | undefined;
  try {
    const progressed = await deps.db.transaction(async (tx) => {
      const event = subscriptionRows<Event>(
        await tx.execute(sql`
      SELECT event.id, event.subscription_id AS "subscriptionId", subscription.workspace_id AS "workspaceId",
        subscription.session_id AS "sessionId", task.id AS "taskId", task.user_workos_id AS "ownerId", event.payload, event.status, event.run_id AS "runId",
        (subscription.status = 'closed' OR subscription.expires_at <= now() OR task.archived_at IS NOT NULL
          OR conversation.closed_at IS NOT NULL
          -- Turning Slack off or retiring the workflow closes its open threads too. Without this
          -- the reply would start a run that has no way to answer, and the person waiting in Slack
          -- would get the generic "needs attention" notice instead of a closed thread. A Task
          -- opened from a Slack direct message has no workflow, so there is nothing to retire.
          OR (task.workflow_id IS NOT NULL
            AND (workflow.id IS NULL OR workflow.slack_channel_enabled IS FALSE OR (workflow.kind = 'agent' AND workflow.status <> 'active')))) AS closed,
        run.status AS "runStatus",
        COALESCE(workflow.slack_bot_display_name, '') AS "botDisplayName",
        COALESCE(workflow.slack_bot_avatar_url, '') AS "botAvatarUrl",
        jsonb_build_object('id', integration.id, 'workspaceId', integration.workspace_id,
          'userWorkosId', integration.user_workos_id, 'teamId', integration.external_id, 'scopes', integration.scopes, 'companyAgentId', integration.company_agent_id) AS installation
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
              -- A paused turn has yielded the runtime and may be the reason this Slack reply
              -- exists. Task comments resume settled Tasks by creating a sibling Run, which is
              -- also how an in-product reply continues a Task whose earlier turn is paused.
              AND active.status IN ('queued', 'running')
          )
        ))
      ORDER BY event.id FOR UPDATE OF task, event SKIP LOCKED LIMIT 1
    `),
      )[0];
      if (!event) return false;
      claimed = event;
      const deliveryId = `subscription_reply_${event.id}`;
      if (event.status === "delivering") {
        const [settled] = subscriptionRows<{ status: string }>(
          await tx.execute(
            sql`SELECT status FROM goat.channel_deliveries WHERE id = ${deliveryId} AND status IN ('sent', 'canceled')`,
          ),
        );
        if (settled) {
          await tx.execute(
            sql`UPDATE goat.subscription_events SET status = 'done' WHERE id = ${event.id}`,
          );
          reaction =
            settled.status === "sent" && runEndedCleanly(event)
              ? REACTION_ANSWERED
              : REACTION_ATTENTION;
        }
        return Boolean(settled);
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
          // The run succeeded but never called the Slack tool, so this thread is getting no reply
          // at all. From the asker's side that is the silence the mark exists to break, not an answer.
          reaction = REACTION_ATTENTION;
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
      await validateDeliverableChannel(deps, token, event.payload.channelId);
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
      if (event.installation.companyAgentId) {
        const email = user.user.profile?.email?.trim().toLowerCase() ?? "";
        const member = subscriptionRows(
          await tx.execute(sql`
          SELECT 1 FROM goat.workspace_members member JOIN goat.users account ON account.workos_user_id = member.user_workos_id
          WHERE member.workspace_id = ${event.workspaceId} AND lower(account.email) = ${email} AND ${email} <> ''
        `),
        );
        if (user.user.team_id !== event.installation.teamId || member.length === 0) {
          await ignoreEvent(tx.execute.bind(tx), event.id);
          return true;
        }
      }
      const thread = await readSlackThread({
        token,
        channelId: event.payload.channelId,
        threadTs: event.payload.threadTs,
        request: deps.request,
        singlePage: Boolean(event.installation.companyAgentId),
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
      reaction = REACTION_WORKING;
      return true;
    });
    if (claimed && reaction) await reactToSlackMessage(deps, claimed, reaction);
    return progressed;
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
// The check mark only means "this message got its reply". Anything else - a failed or interrupted
// run, a closed thread, a run that never answered, a reply Slack never took - leaves work for a
// person and gets the attention mark instead.
function runEndedCleanly(event: Event) {
  return Boolean(event.runId) && event.runStatus !== "failed" && event.runStatus !== "interrupted";
}

// Marking a Slack message is the same job whichever worker asks for it, so this takes the message
// and the install rather than a subscription event. `clearWorking` says whether a working mark was
// ever put there to clear.
export async function markSlackMessage(input: {
  credential: typeof channelBotCredential;
  request: typeof slackApiRequest;
  installation: ChannelInstallation;
  channelId: string;
  messageTs: string;
  emoji: string;
  clearWorking: boolean;
}) {
  if (!slackBotCanReact(input.installation.scopes)) return;
  // An ack never gets to break the work it annotates, so a failed reaction is logged and dropped
  // rather than retried.
  const attempt = (method: string, name: string) =>
    input
      .credential(input.installation)
      .then(({ token }) =>
        input.request({
          method,
          token,
          form: {
            channel: input.channelId,
            timestamp: input.messageTs,
            name,
          },
          signal: AbortSignal.timeout(5_000),
        }),
      )
      .catch((error) =>
        logger.info("Slack thread reaction skipped", {
          slack_method: method,
          reaction: name,
          error_message: error instanceof Error ? error.message : "Unknown error",
        }),
      );
  // Slack has no replace. Add before removing so a swap that only half succeeds leaves the message
  // over-marked rather than unmarked, and only clear a working mark a Run actually put there.
  await attempt("reactions.add", input.emoji);
  if (input.emoji !== REACTION_WORKING && input.clearWorking)
    await attempt("reactions.remove", REACTION_WORKING);
}

async function reactToSlackMessage(
  deps: SlackChannelWorkerDependencies,
  event: Event,
  emoji: string,
) {
  await markSlackMessage({
    credential: deps.credential,
    request: deps.request,
    installation: event.installation,
    channelId: event.payload.channelId,
    messageTs: event.payload.messageTs,
    emoji,
    clearWorking: Boolean(event.runId),
  });
}

// Slack only delivers an `im` event for the bot's own direct message conversation, and chat:write
// covers posting back into it. There is no membership or visibility question to answer, and the
// public-channel validator rejects DM conversations by design.
async function validateDeliverableChannel(
  deps: SlackChannelWorkerDependencies,
  token: string,
  channelId: string,
) {
  if (/^D[A-Z0-9]+$/u.test(channelId)) return;
  await deps.validateChannel(token, channelId);
}

export async function readSlackThread(input: {
  token: string;
  channelId: string;
  threadTs: string;
  request: typeof slackApiRequest;
  singlePage?: boolean;
}) {
  const messages: SlackThreadMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < (input.singlePage ? 1 : 5); page++) {
    const response = await input.request<{
      messages?: SlackThreadMessage[];
      response_metadata?: { next_cursor?: string };
    }>({
      method: "conversations.replies",
      token: input.token,
      form: {
        channel: input.channelId,
        ts: input.threadTs,
        limit: input.singlePage ? "15" : "200",
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
  return `Slack thread follow-up\n\nSender: ${sender}\n\nContinue this same workflow using its saved context and artifacts. The full Slack thread so far is included as context below. Do not create another task or a root Slack message.\n\nBefore writing your final task answer, call ${SLACK_BOT_TOOL_NAME} with your final Slack reply as text and \"slack-follow-up-${input.eventId}\" as messageKey. Omit channel so the tool posts to the originating thread. Reply the way a founder replies in their own team channel: lead with the answer, short sentences, plain words, no preamble. The assistant turn itself is not sent to Slack.\n\n--- Full Slack thread ---\n${messages.join("\n\n")}\n--- End Slack thread ---\n\n--- New follow-up message begins ---\nFrom: ${sender}\n${quoteSlackText(input.text)}\n--- New follow-up message ends ---`;
}

export function slackUserName(user: SlackUser, fallbackId: string) {
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

export function quoteSlackText(text: string) {
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
  await execute(sql`INSERT INTO goat.channel_deliveries (id, workspace_id, session_id, integration_id, team_id, channel_id, thread_ts, text, bot_display_name, bot_avatar_url)
    VALUES (${id}, ${event.workspaceId}, ${event.sessionId}, ${event.installation.id}, ${event.payload.teamId}, ${event.payload.channelId}, ${event.payload.threadTs}, ${concise}, ${event.botDisplayName}, ${event.botAvatarUrl}) ON CONFLICT DO NOTHING`);
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
  botAvatarUrl: string;
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
        -- A reply whose root message never reached Slack has no thread to land in. Posting it
        -- anyway would drop detail into the channel with nothing to read it against.
        OR EXISTS (SELECT 1 FROM goat.channel_deliveries parent
          WHERE parent.id = delivery.thread_parent_id AND parent.status IN ('canceled', 'failed'))
        OR (delivery.thread_ts IS NULL AND (delivery.created_at <= now() - interval '30 days'
          OR EXISTS (SELECT 1 FROM goat.tasks task WHERE task.session_id = delivery.session_id AND task.archived_at IS NOT NULL)
          OR EXISTS (SELECT 1 FROM goat.chat_sessions conversation WHERE conversation.id = delivery.session_id AND conversation.closed_at IS NOT NULL)))
      )`);
    const row = subscriptionRows<Delivery>(
      await tx.execute(sql`
      SELECT delivery.id, delivery.channel_id AS "channelId",
        COALESCE(delivery.thread_ts, parent.message_ts) AS "threadTs", delivery.text,
        delivery.bot_display_name AS "botDisplayName", delivery.bot_avatar_url AS "botAvatarUrl",
        delivery.status, delivery.created_at AS "createdAt",
        jsonb_build_object('id', integration.id, 'workspaceId', integration.workspace_id,
          'userWorkosId', integration.user_workos_id, 'teamId', integration.external_id, 'scopes', integration.scopes, 'companyAgentId', integration.company_agent_id) AS installation
      FROM goat.channel_deliveries delivery JOIN goat.integrations integration ON integration.id = delivery.integration_id AND integration.external_id = delivery.team_id
      LEFT JOIN goat.channel_deliveries parent ON parent.id = delivery.thread_parent_id
      -- A reply is queued before Slack has timestamped its root message. Leaving it unclaimed until
      -- the root is confirmed sent is what keeps the two posts in order and in one thread.
      WHERE integration.status = 'connected'
        AND (delivery.thread_parent_id IS NULL OR (parent.status = 'sent' AND parent.message_ts IS NOT NULL))
        AND ((delivery.status = 'pending' AND (delivery.lease_expires_at IS NULL OR delivery.lease_expires_at < now())) OR (
        delivery.status IN ('sending', 'uncertain') AND delivery.lease_expires_at < now()))
      ORDER BY delivery.created_at FOR UPDATE OF delivery, integration SKIP LOCKED LIMIT 1
    `),
    )[0];
    if (!row) return null;
    // Persist the resolved thread so a reconciliation after a crash reads the thread, not the channel.
    await tx.execute(
      sql`UPDATE goat.channel_deliveries SET status = 'sending', thread_ts = ${row.threadTs}, lease_id = ${leaseId}, lease_expires_at = now() + interval '2 minutes' WHERE id = ${row.id}`,
    );
    return { ...row, leaseId };
  });
  if (!delivery) return false;
  const execute = deps.db.execute.bind(deps.db);
  let postAttempted = delivery.status !== "pending";
  try {
    const { token, botUserId } = await deps.credential(delivery.installation);
    const canCustomizeIdentity =
      !delivery.installation.companyAgentId &&
      slackBotCanCustomizeIdentity(delivery.installation.scopes);
    await validateDeliverableChannel(deps, token, delivery.channelId);
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
          ...(canCustomizeIdentity
            ? {
                ...(delivery.botDisplayName ? { username: delivery.botDisplayName } : {}),
                ...(delivery.botAvatarUrl ? { icon_url: delivery.botAvatarUrl } : {}),
              }
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
  const provisioning = createPollingWorker({
    pollIntervalMs: 3_000,
    onError: () => logger.error("Slack identity provisioning deferred"),
    poll: async () =>
      processNextSlackProvisioning({
        db: getDb(),
        apiOrigin: process.env.OPENCOMPANY_API_ORIGIN || "http://localhost:3001",
      }),
  });
  const channel = createPollingWorker({
    pollIntervalMs: 2_000,
    poll: async () => {
      const deps = defaults();
      await deps.db.execute(
        sql`UPDATE goat.session_subscriptions SET status = 'closed' WHERE status = 'waiting' AND expires_at <= now()`,
      );
      const agentMessage = await processNextSlackAgentMessage().catch((error) => {
        logger.warn("Slack agent message deferred", {
          error_message: error instanceof Error ? error.message : "Unknown error",
        });
        return false;
      });
      if (agentMessage) onRunQueued();
      const directMessage = await processNextSlackDirectMessage().catch((error) => {
        logger.warn("Slack direct message deferred", {
          error_message: error instanceof Error ? error.message : "Unknown error",
        });
        return false;
      });
      if (directMessage) onRunQueued();
      const event = await processNextSubscriptionEvent(deps).catch((error) => {
        logger.warn("Slack reply deferred", {
          error_message: error instanceof Error ? error.message : "Unknown error",
        });
        return false;
      });
      if (event) onRunQueued();
      const delivery = await processNextChannelDelivery(deps);
      return agentMessage || directMessage || event || delivery;
    },
    onError: (error) =>
      logger.error("Slack Channel worker failed", {
        error_message: error instanceof Error ? error.message : "Unknown error",
      }),
  });
  return {
    notify: () => {
      channel.notify();
      provisioning.notify();
    },
    activeCount: () => channel.activeCount() + provisioning.activeCount(),
    stop: async (options?: Parameters<typeof channel.stop>[0]) => {
      await Promise.all([channel.stop(options), provisioning.stop(options)]);
    },
  };
}
