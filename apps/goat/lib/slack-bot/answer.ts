import { calculateModelUsageCost } from "@opencompany/billing";
import { hasPositiveGoatCreditBalance, recordGoatCreditDebit } from "@opencompany/db/goat-credits";
import { loadGoatIntegrationCredential } from "@opencompany/db/goat-integrations";
import { goatSlackSelectedConversationIds } from "@opencompany/db/goat-slack";
import {
  type GoatSlackBotIntegrationForTeam,
  listEnabledGoatSlackBotBrainRoutes,
  listGoatSlackBotIntegrationsForTeam,
} from "@opencompany/db/goat-slack-bot";
import { recordGoatModelCost } from "@opencompany/goat-observability";
import type { LanguageModelUsage } from "ai";
import { slackApiRequest } from "@/lib/integrations/slack";
import { runGoatSlackBotAgent } from "@/lib/slack-bot/agent";

const SLACK_ANSWER_MAX_CHARS = 3000;
const THREAD_CONTEXT_MESSAGE_LIMIT = 20;

export type GoatSlackBotMentionInput = {
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs: string | null;
  text: string;
  slackUserId: string;
};

// Runs after the webhook has already acked Slack (via next/server after()):
// resolve the install → route to brains by channel → answer → post in-thread.
// Failures reply best-effort and log; there is no retry (Slack retries are
// deliberately skipped at the webhook).
export async function processGoatSlackBotMention(input: GoatSlackBotMentionInput) {
  const integrations = await listGoatSlackBotIntegrationsForTeam(input.teamId);
  const active = integrations.filter((integration) => integration.status === "connected");
  if (active.length === 0) return;

  // Normally one install per team; two goat workspaces installing the same
  // Slack team both answer (accepted beta caveat, scoping keeps it unlikely).
  for (const integration of active) {
    await answerForIntegration(integration, input).catch((error) => {
      console.error("[goat-slack-bot] Failed to answer mention", {
        teamId: input.teamId,
        channelId: input.channelId,
        integrationId: integration.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

async function answerForIntegration(
  integration: GoatSlackBotIntegrationForTeam,
  input: GoatSlackBotMentionInput,
) {
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: integration.userWorkosId,
    integrationId: integration.id,
    provider: "slack_bot",
    kind: "oauth_token",
  });
  const botToken =
    typeof credential?.payload.access_token === "string" ? credential.payload.access_token : null;
  const botUserId =
    typeof credential?.payload.bot_user_id === "string" ? credential.payload.bot_user_id : null;
  if (!botToken) {
    console.error("[goat-slack-bot] Missing bot credential", { integrationId: integration.id });
    return;
  }

  const replyThreadTs = input.threadTs ?? input.messageTs;
  const reply = (text: string) => postSlackBotReply(botToken, input.channelId, replyThreadTs, text);

  const routes = await listEnabledGoatSlackBotBrainRoutes(integration.id);
  const brains = routes.filter((route) =>
    goatSlackSelectedConversationIds(route.config).has(input.channelId),
  );
  if (brains.length === 0) {
    await reply(
      "This channel isn't connected to a brain yet. A workspace admin can enable it under Brain settings → Destinations.",
    );
    return;
  }

  if (!(await hasPositiveGoatCreditBalance(integration.workspaceId))) {
    await reply("This workspace is out of credits, so I can't answer right now.");
    return;
  }

  const question = stripSlackBotMention(input.text, botUserId);
  if (!question) {
    await reply(
      "Ask me something, e.g. `@opencompany what did we learn from customers this week?`",
    );
    return;
  }

  try {
    const threadContext = input.threadTs
      ? await fetchThreadContext(botToken, input.channelId, input.threadTs)
      : null;

    const answer = await runGoatSlackBotAgent({
      question,
      threadContext,
      brains: brains.map((route) => ({ brainRef: route.brainRef, brainName: route.brainName })),
      gatewayApiKey: requiredGatewayApiKey(),
      userWorkosId: integration.userWorkosId,
      sourceRef: `slack:${input.teamId}:${input.channelId}:${input.messageTs}`,
    });

    await reply(truncateForSlack(toSlackMrkdwn(answer.text), SLACK_ANSWER_MAX_CHARS));

    await recordSlackBotUsage({
      workspaceId: integration.workspaceId,
      userWorkosId: integration.userWorkosId,
      model: answer.model,
      usage: answer.usage,
      idempotencyKey: `slack_bot:${input.teamId}:${input.channelId}:${input.messageTs}`,
    });
  } catch (error) {
    console.error("[goat-slack-bot] Answer generation failed", {
      integrationId: integration.id,
      channelId: input.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    await reply("Something went wrong answering that. Try again in a minute.").catch(() => {});
  }
}

export function stripSlackBotMention(text: string, botUserId: string | null): string {
  const withoutBot = botUserId
    ? text.replaceAll(new RegExp(`<@${escapeRegExp(botUserId)}(\\|[^>]*)?>`, "g"), " ")
    : // Without a known bot id, strip only a leading mention.
      text.replace(/^\s*<@[A-Z0-9]+(\|[^>]*)?>/i, " ");
  return withoutBot.replace(/\s+/g, " ").trim();
}

// Safety net for models slipping into Markdown: Slack renders ** literally
// and has no heading syntax.
export function toSlackMrkdwn(text: string): string {
  return text.replaceAll(/\*\*(.+?)\*\*/gs, "*$1*").replace(/^#{1,6}\s+(.*)$/gm, "*$1*");
}

export function truncateForSlack(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 2).trimEnd()} …`;
}

async function fetchThreadContext(
  botToken: string,
  channelId: string,
  threadTs: string,
): Promise<string | null> {
  // Best-effort: missing history scope or membership just degrades to no context.
  try {
    const result = await slackApiRequest<{
      messages?: Array<{ user?: string; bot_id?: string; text?: string; ts?: string }>;
    }>({
      method: "conversations.replies",
      token: botToken,
      form: {
        channel: channelId,
        ts: threadTs,
        limit: String(THREAD_CONTEXT_MESSAGE_LIMIT),
      },
    });
    const lines = (result.messages ?? [])
      .filter((message) => typeof message.text === "string" && message.text.trim())
      .map((message) => {
        const author = message.bot_id ? "bot" : (message.user ?? "user");
        return `${author}: ${message.text}`;
      });
    return lines.length > 0 ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

async function postSlackBotReply(
  botToken: string,
  channelId: string,
  threadTs: string,
  text: string,
) {
  try {
    await slackApiRequest({
      method: "chat.postMessage",
      token: botToken,
      form: {
        channel: channelId,
        thread_ts: threadTs,
        text,
        unfurl_links: "false",
      },
    });
  } catch (error) {
    // not_in_channel / channel_not_found: nothing actionable from our side.
    console.error("[goat-slack-bot] chat.postMessage failed", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function recordSlackBotUsage(input: {
  workspaceId: string;
  userWorkosId: string;
  model: string;
  usage: LanguageModelUsage | undefined;
  idempotencyKey: string;
}) {
  if (!input.usage) return;
  const cost = calculateModelUsageCost({
    modelName: input.model,
    inputTokens: readUsageNumber(input.usage.inputTokens),
    inputNoCacheTokens: readUsageNumber(input.usage.inputTokenDetails?.noCacheTokens),
    inputCacheReadTokens: readUsageNumber(input.usage.inputTokenDetails?.cacheReadTokens),
    inputCacheWriteTokens: readUsageNumber(input.usage.inputTokenDetails?.cacheWriteTokens),
    outputTokens: readUsageNumber(input.usage.outputTokens),
  });
  recordGoatModelCost({
    costUsdMicros: cost.totalCostUsdMicros,
    attributes: {
      "goat.model": input.model,
      "goat.surface": "slack_bot",
    },
  });
  if (!cost.billable) return;
  // A debit failure must never block the already-posted answer.
  try {
    await recordGoatCreditDebit({
      workspaceId: input.workspaceId,
      userWorkosId: input.userWorkosId,
      source: "chat_model_usage",
      idempotencyKey: input.idempotencyKey,
      providerCostUsdMicros: cost.providerCostUsdMicros,
      platformFeeUsdMicros: cost.platformFeeUsdMicros,
      totalCostUsdMicros: cost.totalCostUsdMicros,
      costBasis: cost.costBasis,
      metadata: { surface: "slack_bot" },
    });
  } catch (error) {
    console.error("[goat-slack-bot] Credit debit failed", {
      workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readUsageNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function requiredGatewayApiKey() {
  const value = process.env.VERCEL_AI_GATEWAY_API_KEY?.trim();
  if (!value) throw new Error("VERCEL_AI_GATEWAY_API_KEY is required for the Slack bot.");
  return value;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
