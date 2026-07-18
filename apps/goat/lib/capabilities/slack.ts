import { getDb } from "@opencompany/db/client";
import {
  type GoatSlackOAuthCredentialPayload,
  loadGoatIntegrationCredential,
} from "@opencompany/db/goat-integrations";
import { goatIntegrations } from "@opencompany/db/goat-schema";
import { jsonSchema, type ToolSet, tool } from "ai";
import { and, desc, eq } from "drizzle-orm";
import {
  GoatCapabilityAuthError,
  type GoatCapabilityDefinition,
  type GoatCapabilityWorkerContext,
} from "@/lib/capabilities/types";
import { slackApiRequest } from "@/lib/integrations/slack";

const MAX_MESSAGE_TEXT_CHARS = 700;
const MAX_HISTORY_MESSAGES = 30;
const MAX_LISTED_CONVERSATIONS = 100;
const MAX_LISTED_USERS = 100;
const MAX_SEARCH_MATCHES = 20;

type SlackConnection = {
  integrationId: string;
  teamName: string | null;
  hasSearch: boolean;
};

type SlackMessage = {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
};

export const slackCapability: GoatCapabilityDefinition = {
  id: "slack",
  sideEffect: "read",
  workerModel: "openai/gpt-5.4-mini",
  async resolve(userWorkosId) {
    const connection = await loadSlackConnection(userWorkosId);
    if (!connection) return null;

    const workspaceLabel = connection.teamName ? ` "${connection.teamName}"` : "";
    const indexLine = connection.hasSearch
      ? `slack — reads the user's Slack workspace${workspaceLabel}. CAN keyword-search messages, list the user's channels and DMs, read channel and thread history, and look up workspace members. CANNOT read channels the user is not in, or post, edit, or react to anything.`
      : `slack — reads the user's Slack workspace${workspaceLabel}. CAN list the user's channels and DMs, read channel and thread history, and look up workspace members. CANNOT keyword-search the workspace (reconnecting Slack in Settings → Integrations enables search), read channels the user is not in, or post or edit anything.`;

    return {
      indexLine,
      recipeLines: slackRecipeLines(connection.hasSearch),
      createTools: (context) => createSlackTools(context, connection),
    };
  },
};

function slackRecipeLines(hasSearch: boolean): string[] {
  return [
    "Slack ids: channels look like C…/G…, DMs like D…, users like U…. A message's id is its ts value in its channel.",
    'To read a DM with a person: find their user id with slack_list_users, then slack_list_conversations with types ["im"] and match the user field, then slack_fetch_history on that conversation id.',
    "For 'catch me up on #channel' requests, fetch history for that channel and summarize; expand threads with slack_fetch_thread only when a thread clearly matters.",
    ...(hasSearch
      ? [
          "For keyword or topic queries, use slack_search_messages first. Refine with modifiers like in:#channel, from:@displayname, after:YYYY-MM-DD inside the query string.",
        ]
      : [
          'Keyword search is unavailable for this connection. If the request truly requires workspace-wide keyword search, return an error with code "invalid_request" and a hint that reconnecting Slack in Settings → Integrations enables search; otherwise answer from channel or DM history.',
        ]),
    'Cite each message you rely on as an entity: type "slack_message", id "<channel>:<ts>", and copy the url field from the tool output when present.',
  ];
}

async function loadSlackConnection(userWorkosId: string): Promise<SlackConnection | null> {
  const [row] = await getDb()
    .select({
      id: goatIntegrations.id,
      status: goatIntegrations.status,
      connectionLabel: goatIntegrations.connectionLabel,
      scopes: goatIntegrations.scopes,
    })
    .from(goatIntegrations)
    .where(
      and(eq(goatIntegrations.userWorkosId, userWorkosId), eq(goatIntegrations.provider, "slack")),
    )
    .orderBy(desc(goatIntegrations.updatedAt))
    .limit(1);

  if (!row || row.status !== "connected") return null;
  return {
    integrationId: row.id,
    teamName: row.connectionLabel,
    hasSearch: (row.scopes ?? []).some((scope) => scope.startsWith("search:read")),
  };
}

async function createSlackTools(context: GoatCapabilityWorkerContext, connection: SlackConnection) {
  const credential = await loadGoatIntegrationCredential({
    userWorkosId: context.userWorkosId,
    integrationId: connection.integrationId,
    provider: "slack",
    kind: "oauth_token",
  });
  const payload = credential?.payload as GoatSlackOAuthCredentialPayload | undefined;
  const token = payload?.access_token;
  if (!token) {
    throw new GoatCapabilityAuthError(
      "auth_expired",
      "The Slack connection has no usable token; the user needs to reconnect Slack in Settings → Integrations.",
    );
  }
  const teamDomain = payload?.team_domain ?? null;

  const tools: ToolSet = {
    slack_list_conversations: tool({
      description:
        "List the user's Slack conversations: channels, private groups, DMs (im), and group DMs (mpim).",
      inputSchema: jsonSchema<{ types?: string[]; limit?: number }>({
        type: "object",
        additionalProperties: false,
        properties: {
          types: {
            type: "array",
            items: {
              type: "string",
              enum: ["public_channel", "private_channel", "im", "mpim"],
            },
            description: "Conversation types to include. Defaults to all types.",
          },
          limit: { type: "number", description: "Max conversations to return (default 50)." },
        },
      }),
      execute: async (args) => {
        const result = await slackApiRequest<{
          channels?: Array<{
            id?: string;
            name?: string;
            is_im?: boolean;
            is_mpim?: boolean;
            user?: string;
            topic?: { value?: string };
          }>;
        }>({
          method: "conversations.list",
          token,
          form: {
            types: (args.types?.length
              ? args.types
              : ["public_channel", "private_channel", "im", "mpim"]
            ).join(","),
            exclude_archived: "true",
            limit: String(clampCount(args.limit, 50, MAX_LISTED_CONVERSATIONS)),
          },
        });
        return {
          conversations: (result.channels ?? []).map((channel) => ({
            id: channel.id,
            name: channel.name,
            is_im: channel.is_im === true || undefined,
            is_mpim: channel.is_mpim === true || undefined,
            user: channel.user,
            topic: truncateText(channel.topic?.value, 120),
          })),
        };
      },
    }),
    slack_fetch_history: tool({
      description: "Fetch recent messages from one Slack conversation (channel, DM, or group DM).",
      inputSchema: jsonSchema<{
        channel: string;
        oldest_iso?: string;
        latest_iso?: string;
        limit?: number;
      }>({
        type: "object",
        additionalProperties: false,
        properties: {
          channel: { type: "string", description: "Conversation id (C…, G…, or D…)." },
          oldest_iso: {
            type: "string",
            description: "Only messages after this ISO 8601 timestamp.",
          },
          latest_iso: {
            type: "string",
            description: "Only messages before this ISO 8601 timestamp.",
          },
          limit: { type: "number", description: "Max messages to return (default 20)." },
        },
        required: ["channel"],
      }),
      execute: async (args) => {
        const result = await slackApiRequest<{ messages?: SlackMessage[] }>({
          method: "conversations.history",
          token,
          form: {
            channel: args.channel,
            limit: String(clampCount(args.limit, 20, MAX_HISTORY_MESSAGES)),
            ...(args.oldest_iso ? { oldest: isoToSlackTs(args.oldest_iso) } : {}),
            ...(args.latest_iso ? { latest: isoToSlackTs(args.latest_iso) } : {}),
          },
        });
        return { messages: compactMessages(result.messages, args.channel, teamDomain) };
      },
    }),
    slack_fetch_thread: tool({
      description: "Fetch the replies of one Slack thread.",
      inputSchema: jsonSchema<{ channel: string; thread_ts: string; limit?: number }>({
        type: "object",
        additionalProperties: false,
        properties: {
          channel: { type: "string", description: "Conversation id containing the thread." },
          thread_ts: { type: "string", description: "The ts of the thread's parent message." },
          limit: { type: "number", description: "Max replies to return (default 20)." },
        },
        required: ["channel", "thread_ts"],
      }),
      execute: async (args) => {
        const result = await slackApiRequest<{ messages?: SlackMessage[] }>({
          method: "conversations.replies",
          token,
          form: {
            channel: args.channel,
            ts: args.thread_ts,
            limit: String(clampCount(args.limit, 20, MAX_HISTORY_MESSAGES)),
          },
        });
        return { messages: compactMessages(result.messages, args.channel, teamDomain) };
      },
    }),
    slack_list_users: tool({
      description: "List members of the Slack workspace to resolve names to user ids.",
      inputSchema: jsonSchema<{ limit?: number }>({
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "number", description: "Max members to return (default 100)." },
        },
      }),
      execute: async (args) => {
        const result = await slackApiRequest<{
          members?: Array<{
            id?: string;
            name?: string;
            deleted?: boolean;
            is_bot?: boolean;
            real_name?: string;
            profile?: { title?: string };
          }>;
        }>({
          method: "users.list",
          token,
          form: { limit: String(clampCount(args.limit, 100, MAX_LISTED_USERS)) },
        });
        return {
          members: (result.members ?? [])
            .filter((member) => !member.deleted && !member.is_bot)
            .map((member) => ({
              id: member.id,
              name: member.name,
              real_name: member.real_name,
              title: truncateText(member.profile?.title, 80),
            })),
        };
      },
    }),
  };

  if (connection.hasSearch) {
    tools.slack_search_messages = tool({
      description:
        "Keyword-search messages across the Slack workspace. Supports modifiers like in:#channel, from:@displayname, after:YYYY-MM-DD inside the query.",
      inputSchema: jsonSchema<{ query: string; count?: number }>({
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "The search query, including any modifiers." },
          count: { type: "number", description: "Max matches to return (default 10)." },
        },
        required: ["query"],
      }),
      execute: async (args) => {
        const result = await slackApiRequest<{
          messages?: {
            matches?: Array<{
              ts?: string;
              text?: string;
              user?: string;
              username?: string;
              permalink?: string;
              channel?: { id?: string; name?: string };
            }>;
          };
        }>({
          method: "search.messages",
          token,
          form: {
            query: args.query,
            count: String(clampCount(args.count, 10, MAX_SEARCH_MATCHES)),
          },
        });
        return {
          matches: (result.messages?.matches ?? []).map((match) => ({
            ts: match.ts,
            channel_id: match.channel?.id,
            channel_name: match.channel?.name,
            user: match.user,
            username: match.username,
            text: truncateText(match.text, MAX_MESSAGE_TEXT_CHARS),
            url: match.permalink,
          })),
        };
      },
    });
  }

  return { tools };
}

function compactMessages(
  messages: SlackMessage[] | undefined,
  channel: string,
  teamDomain: string | null,
) {
  return (messages ?? []).map((message) => ({
    ts: message.ts,
    user: message.user,
    text: truncateText(message.text, MAX_MESSAGE_TEXT_CHARS),
    thread_ts: message.thread_ts,
    reply_count: message.reply_count,
    url: slackPermalink(teamDomain, channel, message.ts),
  }));
}

function slackPermalink(teamDomain: string | null, channel: string, ts: string | undefined) {
  if (!teamDomain || !ts) return undefined;
  return `https://${teamDomain}.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

function isoToSlackTs(iso: string) {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) throw new Error(`Invalid ISO timestamp: ${iso}`);
  return String(parsed / 1000);
}

function clampCount(value: number | undefined, fallback: number, max: number) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(1, Math.min(Math.floor(value), max));
}

function truncateText(value: string | undefined, maxChars: number) {
  if (value === undefined) return undefined;
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}
