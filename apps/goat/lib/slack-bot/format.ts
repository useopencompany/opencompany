// Pure Slack text helpers shared by the answer pipeline and thread-context
// reconstruction.

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
  return text
    .replaceAll(/\*\*(.+?)\*\*/gs, "*$1*")
    .replace(/^#{1,6}\s+(.*)$/gm, "*$1*")
    .replaceAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>");
}

export function truncateForSlack(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 2).trimEnd()} …`;
}

// True when the text mentions any human user other than the bot — the signal
// that a thread follow-up is addressed at a person, not at us.
export function mentionsOtherHuman(text: string, botUserId: string | null): boolean {
  const mentions = text.match(/<@([A-Z0-9]+)(\|[^>]*)?>/gi) ?? [];
  return mentions.some((token) => {
    const id = token.replace(/^<@/, "").replace(/(\|[^>]*)?>$/, "");
    return botUserId === null || id !== botUserId;
  });
}

export function mentionsSlackUser(text: string, userId: string | null): boolean {
  if (!userId) return false;
  return new RegExp(`<@${escapeRegExp(userId)}(\\|[^>]*)?>`).test(text);
}

export function collectSlackMentionUserIds(texts: readonly string[]): Set<string> {
  const userIds = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/gi)) {
      const userId = match[1];
      if (userId) userIds.add(userId);
    }
  }
  return userIds;
}

// LLM output must not be able to ping an invented user, @channel, @here, or a
// user group. Preserve only user mentions that were already present in the
// conversation; render every other mention-like token as inert inline code.
export function sanitizeSlackMentions(text: string, allowedUserIds: ReadonlySet<string>): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/gi, (token, userId: string) =>
      allowedUserIds.has(userId) ? token : `\`@${userId}\``,
    )
    .replace(
      /<!(channel|here|everyone|subteam\^[^>|]+)(?:\|[^>]*)?>/gi,
      (_token, target: string) => {
        const readable = target.startsWith("subteam^") ? "user-group" : target;
        return `\`@${readable}\``;
      },
    );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
