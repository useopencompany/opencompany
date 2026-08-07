import { isValidBrainSourceRef } from "@opencompany/brain";
import { getDb } from "@opencompany/db/client";
import {
  loadIntegrationCredential,
  type SlackOAuthCredentialPayload,
} from "@opencompany/db/integrations";
import { integrations } from "@opencompany/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { slackApiRequest } from "../integrations/slack";
import { effectiveCapabilityMode, providerCapability } from "./capabilities";
import {
  ACTION_EFFECTS_READ,
  ActionAuthError,
  type ActionExecuteContext,
  ActionInvalidParamsError,
  type ActionProviderCatalog,
  clampCount,
  optionalNumberParam,
  optionalStringParam,
  type ResolvedAction,
  requiredStringParam,
  truncateText,
} from "./types";

const MAX_MESSAGE_TEXT_CHARS = 700;
const MAX_HISTORY_MESSAGES = 30;
const MAX_LISTED_CONVERSATIONS = 100;
const MAX_LISTED_USERS = 100;
const MAX_SEARCH_MATCHES = 20;
const MAX_CONVERSATION_RESOLUTION_PAGES = 5;
const MAX_SLACK_CURSOR_CHARS = 1_000;
const SLACK_CONVERSATION_ID_PATTERN = /^[CGD][A-Z0-9]{6,}$/;

const CONVERSATION_TYPES = ["public_channel", "private_channel", "im", "mpim"] as const;

type SlackConnection = {
  integrationId: string;
  teamName: string | null;
  hasSearch: boolean;
  capabilityModes: unknown;
};

type SlackCredential = {
  token: string;
  integrationId: string;
  teamId: string;
  teamDomain: string | null;
};

type SlackMessage = {
  ts?: string;
  user?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
};

type SlackConversation = {
  id?: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  user?: string;
  topic?: { value?: string };
};

export async function resolveSlackActions(
  userWorkosId: string,
): Promise<ActionProviderCatalog | null> {
  const connection = await loadSlackConnection(userWorkosId);
  if (!connection) return null;
  if (effectiveCapabilityMode("slack", "read", connection.capabilityModes) === "off") return null;
  const readPermission = slackReadPermission(connection);

  // The credential is loaded lazily on first execute so catalog resolution
  // never touches secrets; memoized per catalog (one chat request).
  let credentialPromise: Promise<SlackCredential> | null = null;
  const getCredential = (context: ActionExecuteContext) => {
    credentialPromise ??= loadSlackCredential(context.userWorkosId, connection).catch((error) => {
      credentialPromise = null;
      throw error;
    });
    return credentialPromise;
  };

  let conversationIndexPromise: Promise<SlackConversationIndex> | null = null;
  const resolveConversationId = async (
    value: string,
    context: ActionExecuteContext,
    credential: SlackCredential,
  ) => {
    if (SLACK_CONVERSATION_ID_PATTERN.test(value)) return value;
    const normalizedName = normalizeConversationName(value);
    if (!normalizedName) {
      throw new ActionInvalidParamsError('"channel" must be a conversation id or name.');
    }
    conversationIndexPromise ??= loadSlackConversationIndex(credential.token, context.signal).catch(
      (error) => {
        conversationIndexPromise = null;
        throw error;
      },
    );
    const index = await conversationIndexPromise;
    const matches = index.byName.get(normalizedName) ?? [];
    if (matches.length === 0) {
      throw new ActionInvalidParamsError(
        `No Slack conversation named ${JSON.stringify(value)} was found across ${index.searched} conversations. Try slack.list_conversations to inspect available names and ids.`,
      );
    }
    if (matches.length > 1) {
      throw new ActionInvalidParamsError(
        `Multiple Slack conversations match ${JSON.stringify(value)}: ${matches
          .map((match) => `${match.name} (${match.id})`)
          .join(", ")}. Pass the conversation id instead.`,
      );
    }
    return matches[0]!.id;
  };

  const actions: ResolvedAction[] = [
    {
      id: "slack.list_conversations",
      provider: "slack",
      capability: "read",
      effects: ACTION_EFFECTS_READ,
      ...readPermission,
      description:
        "List the user's Slack conversations: channels, private groups, DMs (im), and group DMs (mpim). Channel ids look like C…/G…, DMs like D…. To find a DM with a person, resolve their user id via slack.list_users first, then match the user field on im conversations.",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          types: {
            type: "array",
            items: { type: "string", enum: [...CONVERSATION_TYPES] },
            description: "Conversation types to include. Defaults to all types.",
          },
          limit: { type: "number", description: "Max conversations to return (default 50)." },
          cursor: {
            type: "string",
            minLength: 1,
            maxLength: MAX_SLACK_CURSOR_CHARS,
            description: "Pagination cursor returned as next_cursor by a previous call.",
          },
        },
      },
      execute: async (params, context) => {
        const credential = await getCredential(context);
        const types = parseConversationTypes(params.types);
        const cursor = boundedOptionalString(params, "cursor", MAX_SLACK_CURSOR_CHARS);
        const result = await slackApiRequest<{
          channels?: SlackConversation[];
          response_metadata?: { next_cursor?: string };
        }>({
          method: "conversations.list",
          token: credential.token,
          signal: context.signal,
          form: {
            types: (types.length ? types : [...CONVERSATION_TYPES]).join(","),
            exclude_archived: "true",
            limit: String(
              clampCount(optionalNumberParam(params, "limit"), 50, MAX_LISTED_CONVERSATIONS),
            ),
            ...(cursor ? { cursor } : {}),
          },
        });
        const nextCursor = boundedString(
          result.response_metadata?.next_cursor,
          MAX_SLACK_CURSOR_CHARS,
        );
        return {
          conversations: (result.channels ?? []).map((channel) => ({
            id: channel.id,
            name: channel.name,
            is_im: channel.is_im === true || undefined,
            is_mpim: channel.is_mpim === true || undefined,
            user: channel.user,
            topic: truncateText(channel.topic?.value, 120),
          })),
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
        };
      },
    },
    {
      id: "slack.fetch_history",
      provider: "slack",
      capability: "read",
      effects: ACTION_EFFECTS_READ,
      ...readPermission,
      description:
        "Fetch one page of recent messages from a Slack conversation (channel, DM, or group DM). A message's id is its ts value in its channel. Pass nextCursor as cursor to continue deeper into history.",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["channel"],
        properties: {
          channel: {
            type: "string",
            description: "Conversation id (C…, G…, D…) or a channel name like #engineering.",
          },
          oldest_iso: {
            type: "string",
            description: "Only messages after this ISO 8601 timestamp.",
          },
          latest_iso: {
            type: "string",
            description: "Only messages before this ISO 8601 timestamp.",
          },
          cursor: {
            type: "string",
            description: "Next-page cursor returned by an earlier slack.fetch_history call.",
          },
          limit: { type: "number", description: "Max messages to return (default 20)." },
        },
      },
      execute: async (params, context) => {
        const credential = await getCredential(context);
        const channel = await resolveConversationId(
          requiredStringParam(params, "channel"),
          context,
          credential,
        );
        const oldestIso = optionalStringParam(params, "oldest_iso");
        const latestIso = optionalStringParam(params, "latest_iso");
        const cursor = optionalStringParam(params, "cursor");
        const result = await slackApiRequest<{
          messages?: SlackMessage[];
          response_metadata?: { next_cursor?: string };
        }>({
          method: "conversations.history",
          token: credential.token,
          signal: context.signal,
          form: {
            channel,
            limit: String(
              clampCount(optionalNumberParam(params, "limit"), 20, MAX_HISTORY_MESSAGES),
            ),
            ...(oldestIso ? { oldest: isoToSlackTs(oldestIso) } : {}),
            ...(latestIso ? { latest: isoToSlackTs(latestIso) } : {}),
            ...(cursor ? { cursor } : {}),
          },
        });
        return {
          integrationId: credential.integrationId,
          messages: compactMessages(result.messages, channel, credential),
          ...(result.response_metadata?.next_cursor
            ? { nextCursor: result.response_metadata.next_cursor }
            : {}),
        };
      },
    },
    {
      id: "slack.fetch_thread",
      provider: "slack",
      capability: "read",
      effects: ACTION_EFFECTS_READ,
      ...readPermission,
      description: "Fetch the replies of one Slack thread.",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["channel", "thread_ts"],
        properties: {
          channel: {
            type: "string",
            description: "Conversation id (C…, G…, D…) or a channel name like #engineering.",
          },
          thread_ts: { type: "string", description: "The ts of the thread's parent message." },
          limit: { type: "number", description: "Max replies to return (default 20)." },
        },
      },
      execute: async (params, context) => {
        const threadTs = requiredStringParam(params, "thread_ts");
        const credential = await getCredential(context);
        const channel = await resolveConversationId(
          requiredStringParam(params, "channel"),
          context,
          credential,
        );
        const result = await slackApiRequest<{ messages?: SlackMessage[] }>({
          method: "conversations.replies",
          token: credential.token,
          signal: context.signal,
          form: {
            channel,
            ts: threadTs,
            limit: String(
              clampCount(optionalNumberParam(params, "limit"), 20, MAX_HISTORY_MESSAGES),
            ),
          },
        });
        return {
          integrationId: credential.integrationId,
          messages: compactMessages(result.messages, channel, credential),
        };
      },
    },
    {
      id: "slack.list_users",
      provider: "slack",
      capability: "read",
      effects: ACTION_EFFECTS_READ,
      ...readPermission,
      description: "List members of the Slack workspace to resolve names to user ids (U…).",
      params: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "number", description: "Max members to return (default 100)." },
        },
      },
      execute: async (params, context) => {
        const credential = await getCredential(context);
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
          token: credential.token,
          signal: context.signal,
          form: {
            limit: String(clampCount(optionalNumberParam(params, "limit"), 100, MAX_LISTED_USERS)),
          },
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
    },
  ];

  if (connection.hasSearch) {
    actions.push({
      id: "slack.search_messages",
      provider: "slack",
      capability: "read",
      effects: ACTION_EFFECTS_READ,
      ...readPermission,
      description:
        "Keyword-search messages across the Slack workspace. Supports modifiers like in:#channel, from:@displayname, after:YYYY-MM-DD inside the query.",
      params: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "The search query, including any modifiers." },
          count: { type: "number", description: "Max matches to return (default 10)." },
        },
      },
      execute: async (params, context) => {
        const credential = await getCredential(context);
        const result = await slackApiRequest<{
          messages?: {
            matches?: Array<{
              ts?: string;
              thread_ts?: string;
              text?: string;
              user?: string;
              username?: string;
              permalink?: string;
              channel?: { id?: string; name?: string };
            }>;
          };
        }>({
          method: "search.messages",
          token: credential.token,
          signal: context.signal,
          form: {
            query: requiredStringParam(params, "query"),
            count: String(clampCount(optionalNumberParam(params, "count"), 10, MAX_SEARCH_MATCHES)),
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
            ...(match.channel?.id && match.ts
              ? {
                  sourceRef: slackSourceRef(
                    credential.teamId,
                    match.channel.id,
                    match.thread_ts ?? match.ts,
                  ),
                }
              : {}),
            integrationId: credential.integrationId,
          })),
          integrationId: credential.integrationId,
        };
      },
    });
  }

  return {
    id: "slack",
    label: connection.teamName ? `Slack workspace "${connection.teamName}"` : "Slack workspace",
    description: "Read conversations, messages, threads, and workspace members.",
    actions,
  };
}

async function loadSlackConnection(userWorkosId: string): Promise<SlackConnection | null> {
  const [row] = await getDb()
    .select({
      id: integrations.id,
      status: integrations.status,
      connectionLabel: integrations.connectionLabel,
      scopes: integrations.scopes,
      capabilityModes: integrations.capabilityModes,
    })
    .from(integrations)
    .where(and(eq(integrations.userWorkosId, userWorkosId), eq(integrations.provider, "slack")))
    .orderBy(desc(integrations.updatedAt))
    .limit(1);

  if (!row || row.status !== "connected") return null;
  return {
    integrationId: row.id,
    teamName: row.connectionLabel,
    hasSearch: (row.scopes ?? []).includes("search:read"),
    capabilityModes: row.capabilityModes,
  };
}

function slackReadPermission(
  connection: SlackConnection,
): Pick<ResolvedAction, "permissionMode" | "permission"> {
  if (effectiveCapabilityMode("slack", "read", connection.capabilityModes) !== "ask") {
    return { permissionMode: "on" };
  }
  return {
    permissionMode: "ask",
    permission: {
      provider: "slack",
      capabilityId: "read",
      label: providerCapability("slack", "read")?.label ?? "Read Slack",
      integrationIds: [connection.integrationId],
    },
  };
}

async function loadSlackCredential(
  userWorkosId: string,
  connection: SlackConnection,
): Promise<SlackCredential> {
  const credential = await loadIntegrationCredential({
    userWorkosId,
    integrationId: connection.integrationId,
    provider: "slack",
    kind: "oauth_token",
  });
  const payload = credential?.payload as SlackOAuthCredentialPayload | undefined;
  const token = payload?.access_token;
  const teamId = payload?.team_id;
  if (!token || !teamId) {
    throw new ActionAuthError(
      "auth_expired",
      "slack",
      "The Slack connection has no usable token; reconnect Slack in Settings → Integrations.",
    );
  }
  return {
    token,
    integrationId: connection.integrationId,
    teamId,
    teamDomain: payload?.team_domain ?? null,
  };
}

function parseConversationTypes(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && (CONVERSATION_TYPES as readonly string[]).includes(entry),
  );
}

type SlackConversationIndex = {
  byName: Map<string, Array<{ id: string; name: string }>>;
  searched: number;
};

async function loadSlackConversationIndex(
  token: string,
  signal: AbortSignal,
): Promise<SlackConversationIndex> {
  const byName = new Map<string, Array<{ id: string; name: string }>>();
  let searched = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CONVERSATION_RESOLUTION_PAGES; page += 1) {
    const result = await slackApiRequest<{
      channels?: SlackConversation[];
      response_metadata?: { next_cursor?: string };
    }>({
      method: "conversations.list",
      token,
      signal,
      form: {
        types: CONVERSATION_TYPES.join(","),
        exclude_archived: "true",
        limit: "200",
        ...(cursor ? { cursor } : {}),
      },
    });
    const channels = result.channels ?? [];
    searched += channels.length;
    for (const channel of channels) {
      const id = boundedString(channel.id, 100);
      const name = boundedString(channel.name, 300);
      if (!id || !name) continue;
      const normalizedName = normalizeConversationName(name);
      if (!normalizedName) continue;
      const matches = byName.get(normalizedName) ?? [];
      matches.push({ id, name });
      byName.set(normalizedName, matches);
    }
    cursor = boundedString(result.response_metadata?.next_cursor, MAX_SLACK_CURSOR_CHARS);
    if (!cursor) break;
  }
  return { byName, searched };
}

function normalizeConversationName(value: string) {
  return value.trim().replace(/^#/, "").trim().toLowerCase();
}

function boundedOptionalString(params: Record<string, unknown>, key: string, maxChars: number) {
  const value = optionalStringParam(params, key);
  if (value && value.length > maxChars) {
    throw new ActionInvalidParamsError(`"${key}" must be at most ${maxChars} characters.`);
  }
  return value;
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxChars ? normalized : undefined;
}

function compactMessages(
  messages: SlackMessage[] | undefined,
  channel: string,
  credential: SlackCredential,
) {
  return (messages ?? []).map((message) => ({
    ts: message.ts,
    user: message.user,
    text: truncateText(message.text, MAX_MESSAGE_TEXT_CHARS),
    thread_ts: message.thread_ts,
    reply_count: message.reply_count,
    url: slackPermalink(credential.teamDomain, channel, message.ts),
    ...(message.ts
      ? {
          sourceRef: slackSourceRef(credential.teamId, channel, message.thread_ts ?? message.ts),
        }
      : {}),
    integrationId: credential.integrationId,
  }));
}

function slackSourceRef(teamId: string, channelId: string, ts: string) {
  const sourceRef = `slack:conversation:${teamId}:${channelId}:${ts}`;
  if (!isValidBrainSourceRef(sourceRef)) {
    throw new Error("Slack returned identifiers that cannot form a Brain source reference.");
  }
  return sourceRef;
}

function slackPermalink(teamDomain: string | null, channel: string, ts: string | undefined) {
  if (!teamDomain || !ts) return undefined;
  return `https://${teamDomain}.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

function isoToSlackTs(iso: string) {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new ActionInvalidParamsError(`Invalid ISO timestamp: ${iso}`);
  }
  return String(parsed / 1000);
}
