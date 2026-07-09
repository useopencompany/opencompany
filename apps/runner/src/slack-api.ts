import type {
  NormalizedSlackConversationContent,
  NormalizedSlackConversationMessage,
} from "@opencompany/goat-brain";
import { createLogger } from "@opencompany/observability";

// Read-only Slack Web API helpers for the flush worker's prompt enrichment
// (channel labels, author names). Enrichment failures must never fail a flush:
// every helper degrades to raw Slack ids.

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-slack-api" });

const SLACK_API_TIMEOUT_MS = 10_000;
const SLACK_RETRY_AFTER_CAP_MS = 10_000;
const NAME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NAME_CACHE_MAX_ENTRIES = 5_000;
export const SLACK_CONTEXT_PREVIOUS_MESSAGE_LIMIT = 10;
export const SLACK_CONTEXT_THREAD_LIMIT = 10;
export const SLACK_CONTEXT_MAX_THREADS = 5;

const INGESTED_MESSAGE_SUBTYPES = new Set<string | undefined>([
  undefined,
  "file_share",
  "thread_broadcast",
]);

type CacheEntry = { value: string; expiresAt: number };
const userNameCache = new Map<string, CacheEntry>();

type SlackApiMessage = {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  files?: unknown[];
};

export async function slackApiRequest<T extends Record<string, unknown>>(input: {
  method: string;
  token: string;
  form?: Record<string, string>;
}): Promise<T> {
  const call = async () => {
    const response = await fetch(`https://slack.com/api/${input.method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${input.token}`,
      },
      body: new URLSearchParams(input.form ?? {}).toString(),
      signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
    });
    return response;
  };

  let response = await call();
  if (response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get("retry-after") ?? "1");
    const delayMs = Math.min(
      SLACK_RETRY_AFTER_CAP_MS,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 1000,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response = await call();
  }
  if (!response.ok) {
    throw new Error(`Slack API ${input.method} failed with ${response.status}.`);
  }
  const result = (await response.json()) as T & { ok?: boolean; error?: string };
  if (!result.ok) {
    throw new Error(`Slack API ${input.method} returned ${result.error ?? "an unknown error"}.`);
  }
  return result;
}

// Resolves a display label for a conversation; picks up channel renames at
// flush time. For DMs the label is the counterpart's name.
export async function getSlackConversationLabel(input: {
  token: string;
  teamId: string;
  channelId: string;
  channelType: "channel" | "group" | "im" | "mpim";
}): Promise<string | null> {
  try {
    const result = await slackApiRequest<{
      channel?: { name?: string; user?: string };
    }>({
      method: "conversations.info",
      token: input.token,
      form: { channel: input.channelId },
    });
    if (input.channelType === "im" && result.channel?.user) {
      const names = await resolveSlackUserNames({
        token: input.token,
        teamId: input.teamId,
        userIds: [result.channel.user],
      });
      return names.get(result.channel.user) ?? result.channel.user;
    }
    return result.channel?.name?.trim() || null;
  } catch (error) {
    logger.warn("Slack conversation label lookup failed", {
      event: "opencompany.goat_slack_conversation_label_failed",
      channel_id: input.channelId,
      error,
    });
    return null;
  }
}

export async function resolveSlackUserNames(input: {
  token: string;
  teamId: string;
  userIds: readonly string[];
}): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const now = Date.now();
  const missing: string[] = [];
  for (const userId of new Set(input.userIds)) {
    const cached = userNameCache.get(`${input.teamId}:${userId}`);
    if (cached && cached.expiresAt > now) {
      names.set(userId, cached.value);
    } else {
      missing.push(userId);
    }
  }

  for (const userId of missing) {
    try {
      const result = await slackApiRequest<{
        user?: { real_name?: string; name?: string };
      }>({
        method: "users.info",
        token: input.token,
        form: { user: userId },
      });
      const name = result.user?.real_name?.trim() || result.user?.name?.trim();
      if (!name) continue;
      names.set(userId, name);
      cacheUserName(`${input.teamId}:${userId}`, name);
    } catch (error) {
      logger.warn("Slack user name lookup failed", {
        event: "opencompany.goat_slack_user_name_failed",
        slack_user_id: userId,
        error,
      });
    }
  }
  return names;
}

export async function fetchSlackConversationContext(input: {
  token: string;
  teamId: string;
  channelId: string;
  windowStartTs: string;
  currentMessages: readonly NormalizedSlackConversationMessage[];
  previousLimit?: number;
  threadLimit?: number;
  maxThreads?: number;
}): Promise<NormalizedSlackConversationContent["conversation"]["context"] | undefined> {
  const previousLimit = input.previousLimit ?? SLACK_CONTEXT_PREVIOUS_MESSAGE_LIMIT;
  const threadLimit = input.threadLimit ?? SLACK_CONTEXT_THREAD_LIMIT;
  const maxThreads = input.maxThreads ?? SLACK_CONTEXT_MAX_THREADS;
  const currentTs = new Set(input.currentMessages.map((message) => message.ts));

  const previousRaw = await fetchPreviousChannelMessages({
    token: input.token,
    channelId: input.channelId,
    windowStartTs: input.windowStartTs,
    limit: previousLimit,
  });

  const threadTsValues = Array.from(
    new Set(
      input.currentMessages.flatMap((message) =>
        message.threadTs && message.threadTs !== message.ts ? [message.threadTs] : [],
      ),
    ),
  ).slice(0, maxThreads);

  const threadRaw = await Promise.all(
    threadTsValues.map(async (threadTs) => ({
      threadTs,
      messages: await fetchThreadMessages({
        token: input.token,
        channelId: input.channelId,
        threadTs,
        windowStartTs: input.windowStartTs,
        limit: threadLimit,
      }),
    })),
  );

  const allRows = [...previousRaw, ...threadRaw.flatMap((thread) => thread.messages)].filter(
    (message) => message.user,
  );
  const userNames = await resolveSlackUserNames({
    token: input.token,
    teamId: input.teamId,
    userIds: allRows.flatMap((message) => (message.user ? [message.user] : [])),
  });

  const previousMessages = normalizeSlackApiMessages(previousRaw, {
    excludedTs: currentTs,
    userNames,
  });
  const threads = threadRaw.flatMap((thread) => {
    const messages = normalizeSlackApiMessages(thread.messages, {
      excludedTs: currentTs,
      userNames,
    });
    return messages.length > 0 ? [{ threadTs: thread.threadTs, messages }] : [];
  });

  if (previousMessages.length === 0 && threads.length === 0) return undefined;
  return {
    ...(previousMessages.length > 0 ? { previousMessages } : {}),
    ...(threads.length > 0 ? { threads } : {}),
  };
}

function cacheUserName(key: string, value: string) {
  if (userNameCache.size >= NAME_CACHE_MAX_ENTRIES) {
    const oldest = userNameCache.keys().next().value;
    if (oldest !== undefined) userNameCache.delete(oldest);
  }
  userNameCache.set(key, { value, expiresAt: Date.now() + NAME_CACHE_TTL_MS });
}

async function fetchPreviousChannelMessages(input: {
  token: string;
  channelId: string;
  windowStartTs: string;
  limit: number;
}): Promise<SlackApiMessage[]> {
  try {
    const result = await slackApiRequest<{ messages?: SlackApiMessage[] }>({
      method: "conversations.history",
      token: input.token,
      form: {
        channel: input.channelId,
        latest: input.windowStartTs,
        inclusive: "false",
        limit: String(input.limit),
      },
    });
    return Array.isArray(result.messages) ? result.messages : [];
  } catch (error) {
    logger.warn("Slack previous message context lookup failed", {
      event: "opencompany.goat_slack_previous_context_failed",
      channel_id: input.channelId,
      error,
    });
    return [];
  }
}

async function fetchThreadMessages(input: {
  token: string;
  channelId: string;
  threadTs: string;
  windowStartTs: string;
  limit: number;
}): Promise<SlackApiMessage[]> {
  try {
    const result = await slackApiRequest<{ messages?: SlackApiMessage[] }>({
      method: "conversations.replies",
      token: input.token,
      form: {
        channel: input.channelId,
        ts: input.threadTs,
        latest: input.windowStartTs,
        inclusive: "false",
        limit: String(input.limit),
      },
    });
    return Array.isArray(result.messages) ? result.messages : [];
  } catch (error) {
    logger.warn("Slack thread context lookup failed", {
      event: "opencompany.goat_slack_thread_context_failed",
      channel_id: input.channelId,
      thread_ts: input.threadTs,
      error,
    });
    return [];
  }
}

function normalizeSlackApiMessages(
  messages: readonly SlackApiMessage[],
  input: {
    excludedTs: ReadonlySet<string>;
    userNames: ReadonlyMap<string, string>;
  },
): NormalizedSlackConversationMessage[] {
  const seen = new Set<string>();
  return messages
    .flatMap((message) => {
      const ts = typeof message.ts === "string" ? message.ts : "";
      const userId = typeof message.user === "string" ? message.user : "";
      const subtype = typeof message.subtype === "string" ? message.subtype : undefined;
      if (!ts || !userId || message.bot_id || input.excludedTs.has(ts) || seen.has(ts)) return [];
      if (!INGESTED_MESSAGE_SUBTYPES.has(subtype)) return [];
      seen.add(ts);
      const files = normalizeSlackFiles(message.files);
      const userName = input.userNames.get(userId);
      return [
        {
          ts,
          ...(typeof message.thread_ts === "string" ? { threadTs: message.thread_ts } : {}),
          userId,
          ...(userName ? { userName } : {}),
          text: typeof message.text === "string" ? message.text : "",
          ...(subtype ? { subtype } : {}),
          ...(files.length > 0 ? { files } : {}),
        },
      ];
    })
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

function normalizeSlackFiles(files: unknown): Array<{ name: string; mimetype?: string }> {
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => {
    if (!file || typeof file !== "object") return [];
    const record = file as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name) return [];
    return [
      {
        name: record.name,
        ...(typeof record.mimetype === "string" ? { mimetype: record.mimetype } : {}),
      },
    ];
  });
}
