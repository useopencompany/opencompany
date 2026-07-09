import { createLogger } from "@opencompany/observability";

// Read-only Slack Web API helpers for the flush worker's prompt enrichment
// (channel labels, author names). Enrichment failures must never fail a flush:
// every helper degrades to raw Slack ids.

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-slack-api" });

const SLACK_API_TIMEOUT_MS = 10_000;
const SLACK_RETRY_AFTER_CAP_MS = 10_000;
const NAME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NAME_CACHE_MAX_ENTRIES = 5_000;

type CacheEntry = { value: string; expiresAt: number };
const userNameCache = new Map<string, CacheEntry>();

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

function cacheUserName(key: string, value: string) {
  if (userNameCache.size >= NAME_CACHE_MAX_ENTRIES) {
    const oldest = userNameCache.keys().next().value;
    if (oldest !== undefined) userNameCache.delete(oldest);
  }
  userNameCache.set(key, { value, expiresAt: Date.now() + NAME_CACHE_TTL_MS });
}
