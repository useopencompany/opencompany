import { slackApiRequest } from "@opencompany/goat-agent/integrations/slack";
import {
  stripSlackBotMention,
  truncateForSlack,
} from "@opencompany/goat-agent/integrations/slack-bot-format";

// Role-typed conversation reconstruction: the bot's own replies come back as
// assistant turns, everything else as user turns prefixed with the speaker, so
// the agent sees a real dialogue instead of one flattened context blob.

export const SLACK_CONTEXT_MESSAGE_LIMIT = 40;
export const SLACK_CONTEXT_MESSAGE_MAX_CHARS = 4000;
export const SLACK_CONTEXT_TOTAL_MAX_CHARS = 24_000;
const SLACK_CONTEXT_PAGE_LIMIT = 200;
const SLACK_CONTEXT_MAX_PAGES = 3;
const SLACK_CONTEXT_MAX_NAME_LOOKUPS = 10;

export type SlackContextRawMessage = {
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  subtype?: string;
};

type SlackConversationPage = {
  messages?: SlackContextRawMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
};

export type SlackContextMessage = {
  role: "user" | "assistant";
  content: string;
};

// Fetches prior conversation context for a channel thread (conversations.replies)
// or a DM (conversations.history). Best-effort: missing scopes, membership, or
// Slack flakiness degrade to no context, never to a failed answer.
export async function fetchGoatSlackConversationContext(input: {
  botToken: string;
  channelId: string;
  // Thread root when replying in a channel thread; null for DM history.
  threadTs: string | null;
  // The triggering message, excluded here and appended by the caller as the
  // final user turn.
  excludeTs: string;
  botUserId: string | null;
}): Promise<SlackContextMessage[]> {
  try {
    const raw = input.threadTs
      ? await fetchThreadReplies(input.botToken, input.channelId, input.threadTs)
      : await fetchDirectMessageHistory(input.botToken, input.channelId);
    const displayNames = await resolveDisplayNames(input.botToken, raw, input.botUserId);
    return buildGoatSlackContextMessages(raw, {
      botUserId: input.botUserId,
      excludeTs: input.excludeTs,
      displayNames,
    });
  } catch {
    return [];
  }
}

async function fetchThreadReplies(
  botToken: string,
  channelId: string,
  threadTs: string,
): Promise<SlackContextRawMessage[]> {
  const messages: SlackContextRawMessage[] = [];
  let cursor: string | undefined;
  // conversations.replies pages oldest-first. Very long threads (> ~600
  // messages) end up truncated at the head; the trailing-40 trim below plus
  // the explicitly appended trigger message keep the answer grounded anyway —
  // strictly better than the previous behavior of dropping all context.
  for (let page = 0; page < SLACK_CONTEXT_MAX_PAGES; page += 1) {
    const result = await slackApiRequest<SlackConversationPage>({
      method: "conversations.replies",
      token: botToken,
      form: {
        channel: channelId,
        ts: threadTs,
        limit: String(SLACK_CONTEXT_PAGE_LIMIT),
        ...(cursor ? { cursor } : {}),
      },
    });
    messages.push(...(result.messages ?? []));
    cursor = result.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return messages;
}

async function fetchDirectMessageHistory(
  botToken: string,
  channelId: string,
): Promise<SlackContextRawMessage[]> {
  // conversations.history returns newest-first; one page bounds the DM context
  // and the reverse restores chronological order.
  const result = await slackApiRequest<SlackConversationPage>({
    method: "conversations.history",
    token: botToken,
    form: {
      channel: channelId,
      limit: String(SLACK_CONTEXT_PAGE_LIMIT),
    },
  });
  return [...(result.messages ?? [])].reverse();
}

// Pure and unit-testable: raw Slack messages → role-typed agent messages.
export function buildGoatSlackContextMessages(
  messages: readonly SlackContextRawMessage[],
  options: {
    botUserId: string | null;
    excludeTs?: string;
    displayNames?: ReadonlyMap<string, string>;
  },
): SlackContextMessage[] {
  const candidates: SlackContextMessage[] = [];
  for (const message of messages) {
    // System subtypes (joins, tombstones, …) carry no conversational content.
    if (message.subtype) continue;
    if (options.excludeTs && message.ts === options.excludeTs) continue;
    const rawText = message.text?.trim();
    if (!rawText) continue;

    if (options.botUserId && message.user === options.botUserId) {
      candidates.push({
        role: "assistant",
        content: truncateForSlack(rawText, SLACK_CONTEXT_MESSAGE_MAX_CHARS),
      });
      continue;
    }

    const text = truncateForSlack(
      stripSlackBotMention(rawText, options.botUserId),
      SLACK_CONTEXT_MESSAGE_MAX_CHARS,
    );
    if (!text) continue;
    const speaker = message.bot_id
      ? "[bot]"
      : message.user
        ? formatSpeaker(message.user, options.displayNames)
        : "[user]";
    candidates.push({ role: "user", content: `${speaker}: ${text}` });
  }

  const trimmed = trimToLimits(candidates);
  return mergeConsecutiveRoles(trimmed);
}

export function formatSpeaker(
  slackUserId: string,
  displayNames?: ReadonlyMap<string, string>,
): string {
  const name = displayNames?.get(slackUserId);
  return name ? `[${name} (<@${slackUserId}>)]` : `[<@${slackUserId}>]`;
}

function trimToLimits(candidates: readonly SlackContextMessage[]): SlackContextMessage[] {
  const recent = candidates.slice(-SLACK_CONTEXT_MESSAGE_LIMIT);
  const selected: SlackContextMessage[] = [];
  let totalChars = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index];
    if (!message) continue;
    if (totalChars + message.content.length > SLACK_CONTEXT_TOTAL_MAX_CHARS) break;
    selected.unshift(message);
    totalChars += message.content.length;
  }
  return selected;
}

// generateText tolerates repeated roles, but merged turns are safer across
// providers and read better in traces.
function mergeConsecutiveRoles(messages: readonly SlackContextMessage[]): SlackContextMessage[] {
  const merged: SlackContextMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous && previous.role === message.role) {
      previous.content = `${previous.content}\n${message.content}`;
      continue;
    }
    merged.push({ ...message });
  }
  return merged;
}

const NAME_CACHE_TTL_MS = 60 * 60 * 1000;
const NAME_CACHE_MAX_ENTRIES = 1000;
const nameCache = new Map<string, { name: string | null; expiresAt: number }>();

async function resolveDisplayNames(
  botToken: string,
  messages: readonly SlackContextRawMessage[],
  botUserId: string | null,
): Promise<Map<string, string>> {
  const distinct: string[] = [];
  for (const message of messages) {
    if (!message.user || message.bot_id || message.user === botUserId) continue;
    if (!distinct.includes(message.user)) distinct.push(message.user);
    if (distinct.length >= SLACK_CONTEXT_MAX_NAME_LOOKUPS) break;
  }

  const resolved = new Map<string, string>();
  const now = Date.now();
  await Promise.all(
    distinct.map(async (userId) => {
      const cached = nameCache.get(userId);
      if (cached && cached.expiresAt > now) {
        if (cached.name) resolved.set(userId, cached.name);
        return;
      }
      try {
        const result = await slackApiRequest<{
          user?: { real_name?: string; name?: string; profile?: { display_name?: string } };
        }>({
          method: "users.info",
          token: botToken,
          form: { user: userId },
        });
        const name =
          result.user?.profile?.display_name?.trim() ||
          result.user?.real_name?.trim() ||
          result.user?.name?.trim() ||
          null;
        if (nameCache.size >= NAME_CACHE_MAX_ENTRIES) {
          const oldestKey = nameCache.keys().next().value;
          if (oldestKey !== undefined) nameCache.delete(oldestKey);
        }
        nameCache.set(userId, { name, expiresAt: now + NAME_CACHE_TTL_MS });
        if (name) resolved.set(userId, name);
      } catch {
        // Raw <@U…> ids remain readable in Slack-literate contexts.
      }
    }),
  );
  return resolved;
}
