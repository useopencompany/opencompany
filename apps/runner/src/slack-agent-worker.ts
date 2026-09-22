import { slackApiRequest } from "@opencompany/agent/integrations/slack";
import {
  type ChannelInstallation,
  channelBotCredential,
  resolvePublicChannel,
} from "@opencompany/agent/integrations/slack-channel";
import { prepareWorkflowRunForUser } from "@opencompany/agent/workflow-tasks";
import {
  type Actor,
  TASK_WRITE_PERMISSION,
  TaskApplicationService,
  WORKFLOW_READ_PERMISSION,
} from "@opencompany/core";
import type { HarnessSpec } from "@opencompany/db/product-schema";
import {
  enqueueSlackThreadReply,
  type SubscriptionExecute,
  subscriptionRows,
} from "@opencompany/db/session-subscriptions";
import { PostgresTaskRepository } from "@opencompany/db/task-repository";
import { PostgresWorkflowRepository } from "@opencompany/db/workflow-repository";
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  markSlackMessage,
  REACTION_WORKING,
  readSlackThread,
  type SlackUser,
  slackFollowUpPrompt,
} from "./slack-channel-worker";
import { resolveSlackWorkspaceMember } from "./slack-workspace-member";

type Message = {
  id: number;
  eventId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  slackUserId: string;
  text: string;
  installation: ChannelInstallation & { companyAgentId: string };
};
export type SlackAgentWorkerDependencies = {
  db: {
    transaction<T>(fn: (tx: { execute: SubscriptionExecute }) => Promise<T>): Promise<T>;
    execute: SubscriptionExecute;
  };
  credential: typeof channelBotCredential;
  request: typeof slackApiRequest;
  validateChannel: typeof resolvePublicChannel;
  prepare: typeof prepareWorkflowRunForUser;
};
const defaults = (): SlackAgentWorkerDependencies => ({
  db: getDb(),
  credential: channelBotCredential,
  request: slackApiRequest,
  validateChannel: resolvePublicChannel,
  prepare: prepareWorkflowRunForUser,
});

export async function processNextSlackAgentMessage(deps = defaults()): Promise<boolean> {
  let claimed: Message | undefined;
  try {
    const result = await deps.db.transaction(async (tx) => {
      const execute = tx.execute.bind(tx);
      const [message] = subscriptionRows<Message>(
        await execute(sql`
        SELECT message.id, message.event_id AS "eventId", message.channel_id AS "channelId",
          message.thread_ts AS "threadTs", message.message_ts AS "messageTs", message.slack_user_id AS "slackUserId", message.text,
          jsonb_build_object('id', integration.id, 'workspaceId', integration.workspace_id,
            'userWorkosId', integration.user_workos_id, 'teamId', integration.external_id,
            'scopes', integration.scopes, 'companyAgentId', integration.company_agent_id) AS installation
        FROM goat.slack_agent_messages message JOIN goat.integrations integration ON integration.id = message.integration_id
        WHERE message.status = 'pending' AND message.next_attempt_at <= now() AND integration.status = 'connected'
        ORDER BY message.id FOR UPDATE OF message, integration SKIP LOCKED LIMIT 1
      `),
      );
      if (!message) return { handled: false };
      claimed = message;
      const mark = async (status: "done" | "ignored") =>
        execute(
          sql`UPDATE goat.slack_agent_messages SET status = ${status} WHERE id = ${message.id}`,
        );
      const { token, botUserId } = await deps.credential(message.installation);
      const response = await deps.request<{ user?: SlackUser }>({
        token,
        method: "users.info",
        form: { user: message.slackUserId },
        signal: AbortSignal.timeout(10000),
      });
      const user = response.user;
      if (
        !user ||
        user.id !== message.slackUserId ||
        user.team_id !== message.installation.teamId ||
        user.is_bot ||
        user.deleted
      ) {
        await mark("ignored");
        return {
          handled: true,
          notice: {
            token,
            message,
            text: "Ask an opencompany workspace admin to invite you with your Slack email before using this agent.",
          },
        };
      }
      const sender = await resolveSlackWorkspaceMember(execute, {
        workspaceId: message.installation.workspaceId,
        teamId: message.installation.teamId,
        slackUserId: message.slackUserId,
        email: user.profile?.email?.trim().toLowerCase() ?? "",
      });
      if (!sender) {
        await mark("ignored");
        return {
          handled: true,
          notice: {
            token,
            message,
            text: "Ask an opencompany workspace admin to invite you with your Slack email before using this agent.",
          },
        };
      }
      if (!message.channelId.startsWith("D")) await deps.validateChannel(token, message.channelId);
      const [owner] = subscriptionRows<{ userId: string; role: "admin" | "member" }>(
        await execute(sql`
        SELECT member.user_workos_id AS "userId", member.role FROM goat.workflows agent
        JOIN goat.workspace_members member ON member.workspace_id = agent.workspace_id AND member.user_workos_id = agent.owner_workos_id
        WHERE agent.id = ${message.installation.companyAgentId} AND agent.workspace_id = ${message.installation.workspaceId}
          AND agent.kind = 'agent' AND agent.status = 'active' AND agent.archived_at IS NULL AND agent.slack_channel_enabled
      `),
      );
      if (!owner) {
        await mark("ignored");
        return { handled: true };
      }
      const event = {
        teamId: message.installation.teamId,
        integrationId: message.installation.id,
        eventId: `slack-agent:${message.id}`,
        channelId: message.channelId,
        threadTs: message.threadTs,
        messageTs: message.messageTs,
        slackUserId: message.slackUserId,
        text: message.text,
      };
      const [subscription] = subscriptionRows(
        await execute(sql`
        SELECT id FROM goat.session_subscriptions WHERE integration_id = ${message.installation.id}
          AND source = 'slack_thread' AND source_key->>'channelId' = ${message.channelId} AND source_key->>'threadTs' = ${message.threadTs}
      `),
      );
      if (subscription) {
        await enqueueSlackThreadReply(execute, event);
        await mark("done");
        return { handled: true };
      }
      const actor: Actor = {
        userId: owner.userId,
        workspaceId: message.installation.workspaceId,
        role: owner.role,
        permissions: [TASK_WRITE_PERMISSION, WORKFLOW_READ_PERMISSION],
        authenticationMethod: "service",
      };
      const workflow = await new PostgresWorkflowRepository(execute, { kind: "agent" }).getWorkflow(
        { actor, workflowId: message.installation.companyAgentId },
      );
      if (!workflow) {
        await mark("ignored");
        return { handled: true };
      }
      const prompt = slackFollowUpPrompt({
        eventId: message.id,
        slackUserId: message.slackUserId,
        text: message.text,
        user,
        botUserId,
        thread: await readSlackThread({
          token,
          channelId: message.channelId,
          threadTs: message.threadTs,
          request: deps.request,
          singlePage: true,
        }),
      });
      const prepared = await deps.prepare({
        userWorkosId: owner.userId,
        workspaceId: actor.workspaceId,
        workflow: {
          id: workflow.slug,
          name: workflow.name,
          description: workflow.description,
          steps: workflow.steps as never,
          scope: "company",
          createdByUserId: workflow.createdByUserId,
        },
        description: prompt,
      });
      const harness = prepared.harnessSpec as HarnessSpec;
      const created = await new TaskApplicationService(
        new PostgresTaskRepository(execute, {
          resolveHarness: async () => harness,
          compatibility: { initialMessageContent: harness.initialUserMessage },
        }),
      ).createTask(actor, {
        idempotencyKey: `slack-agent:${message.id}`,
        name: workflow.name,
        goal: message.text.slice(0, 10000),
        engine: harness.engine,
        model: harness.model,
        source: "workflow",
        workflowId: workflow.slug,
        agentId: workflow.id,
      });
      const sourceKey = {
        teamId: event.teamId,
        channelId: event.channelId,
        threadTs: event.threadTs,
        integrationId: event.integrationId,
      };
      await execute(sql`
        WITH subscription AS (
          INSERT INTO goat.session_subscriptions (id, workspace_id, session_id, integration_id, source, source_key, expires_at)
          VALUES (${`slack_agent_${message.id}`}, ${actor.workspaceId}, ${created.task.conversationId}, ${message.installation.id},
            'slack_thread', ${JSON.stringify(sourceKey)}::jsonb, now() + interval '30 days') RETURNING id
        ) INSERT INTO goat.subscription_events(subscription_id, event_id, sequence, payload, status, run_id)
          SELECT id, ${event.eventId}, 0, ${JSON.stringify(event)}::jsonb, 'running', ${created.runId} FROM subscription
      `);
      await mark("done");
      return { handled: true, started: message };
    });
    if (result.started)
      await markSlackMessage({
        credential: deps.credential,
        request: deps.request,
        installation: result.started.installation,
        channelId: result.started.channelId,
        messageTs: result.started.messageTs,
        emoji: REACTION_WORKING,
        clearWorking: false,
      });
    if (result.notice)
      await deps.request({
        token: result.notice.token,
        method: "chat.postMessage",
        form: {
          channel: result.notice.message.channelId,
          thread_ts: result.notice.message.threadTs,
          text: result.notice.text,
        },
        signal: AbortSignal.timeout(10000),
      });
    return result.handled;
  } catch (error) {
    if (claimed) {
      await deps.db.execute(sql`UPDATE goat.slack_agent_messages SET attempt_count = attempt_count + 1,
      next_attempt_at = now() + interval '1 minute', status = CASE WHEN attempt_count >= 9 THEN 'ignored' ELSE 'pending' END
      WHERE id = ${claimed.id} AND status = 'pending'`);
      await deps.db.execute(sql`UPDATE goat.integrations SET status = 'sync_failed',
        status_reason = 'Slack could not start this conversation after repeated attempts. Check the app permissions and reconnect.', updated_at = now()
        WHERE id = ${claimed.installation.id} AND status = 'connected'
          AND EXISTS (SELECT 1 FROM goat.slack_agent_messages WHERE id = ${claimed.id} AND attempt_count >= 10)`);
    }
    throw error;
  }
}
