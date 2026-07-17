import { getDb } from "@opencompany/db/client";
import { loadGoatIntegrationCredential } from "@opencompany/db/goat-integrations";
import { slackApiRequest } from "@/lib/integrations/slack";
import type { ResolvedSlackAccount } from "./connections";
import type { IntegrationToolExecutor } from "./dispatcher";

// Slack chat tools read with the connected user's token: the model sees only
// what that user can see. search additionally needs the search:read scope,
// which older connections predate — those get a reconnect hint while the
// channel/thread tools keep working.

const SEARCH_RECONNECT_MESSAGE =
  "Slack search needs the search:read permission. Reconnect Slack in Settings → Integrations to enable it; channel history and thread tools still work.";

type SlackApi = typeof slackApiRequest;

export function createSlackIntegrationToolExecutor(input: {
  userWorkosId: string;
  accounts: readonly ResolvedSlackAccount[];
  signal?: AbortSignal;
  // Injectable for tests.
  api?: SlackApi;
  loadCredential?: typeof loadGoatIntegrationCredential;
}): IntegrationToolExecutor {
  const api = input.api ?? slackApiRequest;
  const loadCredential = input.loadCredential ?? loadGoatIntegrationCredential;
  const tokens = new Map<string, Promise<string>>();
  const userNames = new Map<string, string>();

  const resolveAccount = (accountArg: unknown): ResolvedSlackAccount => {
    if (input.accounts.length === 0) throw new Error("Slack is not connected.");
    const fragment = typeof accountArg === "string" ? accountArg.trim().toLowerCase() : "";
    if (!fragment) {
      if (input.accounts.length === 1) return input.accounts[0]!;
      throw new Error(
        `Multiple Slack workspaces are connected (${describeAccounts(input.accounts)}). Pass account with the workspace name.`,
      );
    }
    const match = input.accounts.find(
      (account) =>
        account.teamId?.toLowerCase() === fragment ||
        account.teamName?.toLowerCase().includes(fragment),
    );
    if (!match) {
      throw new Error(
        `No connected Slack workspace matches ${JSON.stringify(String(accountArg))}. Connected: ${describeAccounts(input.accounts)}.`,
      );
    }
    return match;
  };

  const resolveToken = (account: ResolvedSlackAccount) => {
    let token = tokens.get(account.integrationId);
    if (!token) {
      token = (async () => {
        const credential = await loadCredential({
          userWorkosId: input.userWorkosId,
          integrationId: account.integrationId,
          provider: "slack",
          kind: "oauth_token",
          db: getDb(),
        });
        const accessToken =
          credential && typeof credential.payload.access_token === "string"
            ? credential.payload.access_token
            : null;
        if (!accessToken) {
          throw new Error("Reconnect Slack in Settings → Integrations.");
        }
        return accessToken;
      })();
      tokens.set(account.integrationId, token);
    }
    return token;
  };

  const resolveUserNames = async (token: string, userIds: readonly string[]) => {
    for (const userId of new Set(userIds)) {
      if (!userId || userNames.has(userId)) continue;
      try {
        const result = await api<{ user?: { real_name?: string; name?: string } }>({
          method: "users.info",
          token,
          form: { user: userId },
        });
        const name = result.user?.real_name?.trim() || result.user?.name?.trim();
        if (name) userNames.set(userId, name);
      } catch {
        // Display names are best-effort; fall back to the raw user id.
      }
    }
  };

  const listChannels = async (token: string, limit: number, nameFragment?: string | null) => {
    const result = await api<{
      channels?: Array<{
        id?: string;
        name?: string;
        is_private?: boolean;
        is_archived?: boolean;
        num_members?: number;
      }>;
    }>({
      method: "conversations.list",
      token,
      form: {
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: "1000",
      },
    });
    const fragment = nameFragment?.toLowerCase() ?? null;
    return (result.channels ?? [])
      .filter((channel) => channel.id && channel.name)
      .filter((channel) => !fragment || channel.name!.toLowerCase().includes(fragment))
      .slice(0, limit)
      .map((channel) => ({
        id: channel.id!,
        name: channel.name!,
        isPrivate: channel.is_private === true,
        memberCount: typeof channel.num_members === "number" ? channel.num_members : null,
      }));
  };

  const resolveChannelId = async (token: string, ref: string) => {
    const trimmed = ref.trim();
    if (/^[CGD][A-Z0-9]{7,}$/.test(trimmed)) return trimmed;
    const name = trimmed.replace(/^#/, "").toLowerCase();
    const channels = await listChannels(token, 1000);
    const match = channels.find((channel) => channel.name.toLowerCase() === name);
    if (!match) {
      throw new Error(
        `No Slack channel named ${JSON.stringify(trimmed)} was found among the channels the connected user can see. Use slack_list_channels to look up the channel.`,
      );
    }
    return match.id;
  };

  const mapMessages = async (token: string, rawMessages: Array<Record<string, unknown>>) => {
    const userIds = rawMessages
      .map((message) => (typeof message.user === "string" ? message.user : ""))
      .filter(Boolean);
    await resolveUserNames(token, userIds);
    return rawMessages.map((message) => {
      const userId = typeof message.user === "string" ? message.user : null;
      return {
        user: (userId ? userNames.get(userId) : null) ?? userId ?? "unknown",
        text: typeof message.text === "string" ? message.text : "",
        ts: typeof message.ts === "string" ? message.ts : null,
        ...(typeof message.thread_ts === "string" ? { threadTs: message.thread_ts } : {}),
        ...(typeof message.reply_count === "number" ? { replyCount: message.reply_count } : {}),
      };
    });
  };

  return async ({ tool, args }) => {
    const account = resolveAccount(args.account);
    const token = await resolveToken(account);

    try {
      switch (tool.name) {
        case "slack_search_messages": {
          if (!account.scopes.includes("search:read")) {
            throw new Error(SEARCH_RECONNECT_MESSAGE);
          }
          const result = await api<{
            messages?: {
              total?: number;
              matches?: Array<{
                text?: string;
                ts?: string;
                username?: string;
                user?: string;
                permalink?: string;
                channel?: { id?: string; name?: string };
              }>;
            };
          }>({
            method: "search.messages",
            token,
            form: {
              query: String(args.query),
              count: String(clampLimit(args.limit, 20, 50)),
            },
          });
          return {
            total: result.messages?.total ?? 0,
            matches: (result.messages?.matches ?? []).map((match) => ({
              channel: match.channel?.name ?? match.channel?.id ?? null,
              user: match.username ?? match.user ?? null,
              text: match.text ?? "",
              ts: match.ts ?? null,
              permalink: match.permalink ?? null,
            })),
          };
        }
        case "slack_list_channels": {
          const channels = await listChannels(
            token,
            clampLimit(args.limit, 50, 200),
            typeof args.query === "string" ? args.query : null,
          );
          return { channels };
        }
        case "slack_get_channel_history": {
          const channelId = await resolveChannelId(token, String(args.channel));
          const result = await api<{ messages?: Array<Record<string, unknown>> }>({
            method: "conversations.history",
            token,
            form: { channel: channelId, limit: String(clampLimit(args.limit, 30, 100)) },
          });
          return { channel: channelId, messages: await mapMessages(token, result.messages ?? []) };
        }
        case "slack_get_thread": {
          const channelId = await resolveChannelId(token, String(args.channel));
          const result = await api<{ messages?: Array<Record<string, unknown>> }>({
            method: "conversations.replies",
            token,
            form: {
              channel: channelId,
              ts: String(args.threadTs),
              limit: String(clampLimit(args.limit, 50, 100)),
            },
          });
          return { channel: channelId, messages: await mapMessages(token, result.messages ?? []) };
        }
        default:
          throw new Error(`Unsupported Slack tool ${tool.name}.`);
      }
    } catch (error) {
      // Recorded scopes can go stale; Slack's own missing_scope answer gets the
      // same actionable message as the recorded-scope gate.
      if (error instanceof Error && error.message.includes("missing_scope")) {
        throw new Error(SEARCH_RECONNECT_MESSAGE);
      }
      throw error;
    }
  };
}

function describeAccounts(accounts: readonly ResolvedSlackAccount[]) {
  return accounts
    .map((account) => account.teamName ?? account.teamId ?? "unnamed workspace")
    .join(", ");
}

function clampLimit(value: unknown, fallback: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}
