import { CHAT_FRONTIER_MODEL } from "@opencompany/agent/chat-model-router";
import { SLACK_BOT_TOOL_NAME } from "@opencompany/agent/chat-ui";
import { getAvailableHarnessTools } from "@opencompany/agent/integrations/google-data";
import { slackApiRequest } from "@opencompany/agent/integrations/slack";
import {
  type ChannelInstallation,
  channelBotCredential,
  markChannelError,
} from "@opencompany/agent/integrations/slack-channel";
import { type Actor, TASK_WRITE_PERMISSION, TaskApplicationService } from "@opencompany/core";
import type { HarnessSpec } from "@opencompany/db/product-schema";
import { type SubscriptionExecute, subscriptionRows } from "@opencompany/db/session-subscriptions";
import { PostgresTaskRepository } from "@opencompany/db/task-repository";
import { createLogger } from "@opencompany/observability";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { quoteSlackText, type SlackUser, slackUserName } from "./slack-channel-worker";

const logger = createLogger({ service: "opencompany-runner", runtime: "slack-direct-message" });
// Slack's own cap is generous; the Task goal is capped at 10k, and the full message still reaches
// the model through the harness prompt.
const MAX_SLACK_GOAL_CHARS = 10_000;
const NO_ACCOUNT_REPLY =
  "I could not find an opencompany account for your Slack email. Ask a workspace admin to invite you with that address, then message me again.";

type Request = {
  id: number;
  teamId: string;
  eventId: string;
  channelId: string;
  messageTs: string;
  slackUserId: string;
  text: string;
  installation: ChannelInstallation;
};
type Transaction = { execute: SubscriptionExecute };
export type SlackDirectMessageWorkerDependencies = {
  db: {
    transaction: <T>(body: (tx: Transaction) => Promise<T>) => Promise<T>;
    execute: SubscriptionExecute;
  };
  credential: typeof channelBotCredential;
  request: typeof slackApiRequest;
  harnessTools: typeof getAvailableHarnessTools;
  now: () => Date;
};
const defaults = (): SlackDirectMessageWorkerDependencies => ({
  db: getDb(),
  credential: channelBotCredential,
  request: slackApiRequest,
  harnessTools: getAvailableHarnessTools,
  now: () => new Date(),
});

// A direct message to the workspace bot opens a Task on the sender's own opencompany account and
// answers in that message's thread. The Task is modelled as the first event of a thread
// subscription, so the reply path, delivery reconciliation, and every later follow-up are the
// ones the workflow threads already use.
export async function processNextSlackDirectMessage(deps = defaults()): Promise<boolean> {
  let claimed: Request | undefined;
  try {
    const result = await deps.db.transaction(async (tx) => {
      const execute = tx.execute.bind(tx);
      const request = subscriptionRows<Request>(
        await execute(sql`
        SELECT message.id, message.team_id AS "teamId", message.event_id AS "eventId",
          message.channel_id AS "channelId", message.message_ts AS "messageTs",
          message.slack_user_id AS "slackUserId", message.text,
          jsonb_build_object('id', integration.id, 'workspaceId', integration.workspace_id,
            'userWorkosId', integration.user_workos_id, 'teamId', integration.external_id,
            'scopes', integration.scopes) AS installation
        FROM goat.slack_direct_messages message
        JOIN goat.integrations integration ON integration.provider = 'slack_bot'
          AND integration.external_id = message.team_id AND integration.status = 'connected'
        WHERE message.status = 'pending' AND message.next_attempt_at <= now()
        ORDER BY message.id FOR UPDATE OF message SKIP LOCKED LIMIT 1
      `),
      )[0];
      if (!request) return { handled: false };
      claimed = request;
      const { token, botUserId } = await deps.credential(request.installation);
      if (request.slackUserId === botUserId) {
        await ignore(execute, request.id);
        return { handled: true };
      }
      const response = await deps.request<{ user?: SlackUser }>({
        method: "users.info",
        token,
        form: { user: request.slackUserId },
        signal: AbortSignal.timeout(10_000),
      });
      const user = response.user;
      if (user?.id !== request.slackUserId || user.is_bot || user.deleted) {
        await ignore(execute, request.id);
        return { handled: true };
      }
      // Slack verifies the profile email for its own workspace, and the installation binds that
      // Slack workspace to exactly one opencompany workspace. Membership there is what decides
      // whose account and connected tools the session runs on.
      const email = user.profile?.email?.trim().toLowerCase() ?? "";
      const [member] = subscriptionRows<{ userId: string; role: "admin" | "member" }>(
        await execute(sql`
        SELECT member.user_workos_id AS "userId", member.role
        FROM goat.workspace_members member
        JOIN goat.users account ON account.workos_user_id = member.user_workos_id
        WHERE member.workspace_id = ${request.installation.workspaceId}
          AND lower(account.email) = ${email} AND ${email} <> ''
        ORDER BY member.user_workos_id LIMIT 1
      `),
      );
      if (!member) {
        await ignore(execute, request.id);
        logger.info("Slack direct message had no matching opencompany account", {
          event: "goat.slack_direct_message_unmatched",
          team_id: request.teamId,
        });
        return { handled: true, notice: { request, token } };
      }
      await startSession({ execute, request, member, user, deps });
      return { handled: true };
    });
    // The notice is posted after the inbox row is committed as handled, so a failure here drops a
    // fixed sentence rather than risking a second copy of it on the next attempt.
    if (result.notice) {
      await postNoAccountNotice(deps, result.notice.request, result.notice.token).catch((error) =>
        logger.warn("Slack direct message notice was not delivered", {
          event: "goat.slack_direct_message_notice_failed",
          error_message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return result.handled;
  } catch (error) {
    if (claimed) {
      await deps.db.execute(sql`
        UPDATE goat.slack_direct_messages
        SET attempt_count = attempt_count + 1, next_attempt_at = now() + interval '1 minute',
          last_error = ${(error instanceof Error ? error.message : String(error)).slice(0, 2_000)}
        WHERE id = ${claimed.id} AND status = 'pending'
      `);
      await markChannelError(claimed.installation, error);
    }
    throw error;
  }
}

async function startSession(input: {
  execute: SubscriptionExecute;
  request: Request;
  member: { userId: string; role: "admin" | "member" };
  user: SlackUser;
  deps: SlackDirectMessageWorkerDependencies;
}) {
  const { execute, request, member, deps } = input;
  const now = deps.now();
  const prompt = slackDirectMessagePrompt({
    requestId: request.id,
    slackUserId: request.slackUserId,
    text: request.text,
    user: input.user,
  });
  const harnessSpec: HarnessSpec = {
    schemaVersion: "goat.harness.v1",
    engine: "opencompany",
    model: CHAT_FRONTIER_MODEL,
    systemPrompt: "",
    initialUserMessage: prompt,
    tools: await deps.harnessTools(member.userId),
    skills: [],
    maxModelSteps: 16,
    resultMode: "assistant_final",
  };
  const actor: Actor = {
    userId: member.userId,
    workspaceId: request.installation.workspaceId,
    role: member.role,
    permissions: [TASK_WRITE_PERMISSION],
    authenticationMethod: "service",
  };
  const repository = new PostgresTaskRepository(execute, {
    now: () => now,
    resolveHarness: async () => harnessSpec,
    compatibility: { initialMessageContent: prompt },
  });
  const created = await new TaskApplicationService(repository).createTask(actor, {
    idempotencyKey: `slack-dm:${request.id}`,
    goal: request.text.slice(0, MAX_SLACK_GOAL_CHARS),
    engine: harnessSpec.engine,
    model: harnessSpec.model,
    source: "agent",
  });
  // The subscription and its first event are what make the Task answer in Slack: the run holds the
  // thread's one reply, and every later message in the thread continues this same session.
  const payload = {
    teamId: request.teamId,
    eventId: request.eventId,
    channelId: request.channelId,
    threadTs: request.messageTs,
    messageTs: request.messageTs,
    slackUserId: request.slackUserId,
    text: request.text,
  };
  await execute(sql`
    WITH subscription AS (
      INSERT INTO goat.session_subscriptions
        (id, workspace_id, session_id, integration_id, source, source_key, expires_at)
      VALUES (${`slack_dm_${request.id}`}, ${actor.workspaceId}, ${created.task.conversationId},
        ${request.installation.id}, 'slack_thread',
        jsonb_build_object('teamId', ${request.teamId}::text, 'channelId', ${request.channelId}::text,
          'threadTs', ${request.messageTs}::text),
        ${now.toISOString()}::timestamptz + interval '30 days')
      RETURNING id
    )
    INSERT INTO goat.subscription_events (subscription_id, event_id, sequence, payload, status, run_id)
    SELECT id, ${request.eventId}, 0, ${JSON.stringify(payload)}::jsonb, 'running', ${created.runId}
    FROM subscription
  `);
  await execute(sql`
    UPDATE goat.slack_direct_messages SET status = 'started', session_id = ${created.task.conversationId},
      last_error = NULL WHERE id = ${request.id}
  `);
}

export function slackDirectMessagePrompt(input: {
  requestId: number;
  slackUserId: string;
  text: string;
  user: SlackUser;
}) {
  const name = slackUserName(input.user, input.slackUserId);
  const email = input.user.profile?.email?.replace(/\s+/gu, " ").trim() ?? "";
  const sender = `${name}${email ? ` <${email}>` : ""} (Slack user ${input.slackUserId})`;
  return `Slack direct message\n\nSender: ${sender}\n\nThis session was started by a direct message to the opencompany Slack bot and runs on ${name}'s own account. Answer the message below.\n\nBefore writing your final task answer, call ${SLACK_BOT_TOOL_NAME} once with your Slack reply as text and "slack-dm-${input.requestId}" as messageKey. Omit channel so the tool posts to the originating thread. This thread takes exactly one reply per message, so the whole answer goes in that single call: do not split it and do not pass replyToMessageKey. Reply the way a founder replies in their own team channel: lead with the answer, short sentences, plain words, no preamble. The assistant turn itself is not sent to Slack.\n\n--- Message begins ---\nFrom: ${sender}\n${quoteSlackText(input.text)}\n--- Message ends ---`;
}

async function postNoAccountNotice(
  deps: SlackDirectMessageWorkerDependencies,
  request: Request,
  token: string,
) {
  await deps.request({
    method: "chat.postMessage",
    token,
    signal: AbortSignal.timeout(15_000),
    form: {
      channel: request.channelId,
      thread_ts: request.messageTs,
      text: NO_ACCOUNT_REPLY,
      unfurl_links: "false",
      unfurl_media: "false",
    },
  });
}

async function ignore(execute: SubscriptionExecute, id: number) {
  await execute(
    sql`UPDATE goat.slack_direct_messages SET status = 'ignored', last_error = NULL WHERE id = ${id}`,
  );
}
