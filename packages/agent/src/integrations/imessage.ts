import { createHmac, timingSafeEqual } from "node:crypto";

// messages.dev is the iMessage transport for the personal assistant. opencompany owns one line;
// members pair their own phone by texting a code to it. The API key, webhook secret and line
// handle are platform-level env, never stored per user.
export const MESSAGES_API_BASE_URL = "https://api.messages.dev/v1";
export const IMESSAGE_TOOL_NAME = "imessage_send";
export const IMESSAGE_MAX_TEXT_LENGTH = 2_000;
export const IMESSAGE_MAX_SENDS_PER_TURN = 3;
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

export type ImessageConfig = {
  apiKey: string;
  lineHandle: string;
};

export function imessageConfig(env: NodeJS.ProcessEnv = process.env): ImessageConfig | null {
  const apiKey = env.MESSAGES_API_KEY?.trim();
  const lineHandle = env.MESSAGES_LINE_HANDLE?.trim();
  if (!apiKey || !lineHandle) return null;
  return { apiKey, lineHandle };
}

export function imessageWebhookSecret(env: NodeJS.ProcessEnv = process.env) {
  return env.MESSAGES_WEBHOOK_SECRET?.trim() || undefined;
}

// messages.dev signs `${timestamp}.${rawBody}` with the webhook secret (hex HMAC-SHA256) and
// rejects stale timestamps; the delivery id is the caller's idempotency handle.
export function verifyImessageWebhookSignature(input: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  secret: string | undefined;
  nowMs?: number;
}): boolean {
  const secret = input.secret?.trim();
  if (!secret || !input.timestamp || !input.signature) return false;
  const timestampMs = Number(input.timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - timestampMs) > WEBHOOK_TOLERANCE_MS) return false;
  const expected = createHmac("sha256", secret)
    .update(`${input.timestamp}.${input.rawBody}`)
    .digest("hex");
  const left = Buffer.from(input.signature.trim().toLowerCase());
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type ImessageReceivedEvent = {
  deliveryId: string;
  messageId: string;
  chatId: string | null;
  sender: string;
  text: string;
  isFromMe: boolean;
  sentAt: Date | null;
};

// Narrows a webhook envelope to the one event this channel handles. Anything else, including
// reactions, delivery receipts and malformed payloads, returns null and is acknowledged unchanged.
export function parseImessageReceivedEvent(
  envelope: unknown,
  deliveryIdHeader: string | null,
): ImessageReceivedEvent | null {
  if (!isRecord(envelope) || envelope.event !== "message.received" || !isRecord(envelope.data)) {
    return null;
  }
  const data = envelope.data;
  const deliveryId =
    readString(envelope.delivery_id) ?? deliveryIdHeader?.trim() ?? readString(data.id);
  const messageId = readString(data.id);
  const sender = readString(data.sender);
  if (!deliveryId || !messageId || !sender) return null;
  const text = typeof data.text === "string" ? data.text.trim() : "";
  const sentAtMs = typeof data.sent_at === "number" ? data.sent_at : null;
  return {
    deliveryId,
    messageId,
    chatId: readString(data.chat_id),
    sender,
    text,
    isFromMe: data.is_from_me === true,
    sentAt: sentAtMs ? new Date(sentAtMs) : null,
  };
}

export type ImessageReactionType = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";
export const IMESSAGE_REACTION_TYPES: readonly ImessageReactionType[] = [
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
];

export type MessagesClient = ReturnType<typeof createMessagesClient>;

// Thin fetch wrapper over the three endpoints the assistant uses. Kept dependency-free on purpose:
// the official SDK would be a new package for ~60 lines of HTTP.
export function createMessagesClient(input: {
  config: ImessageConfig;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.baseUrl ?? MESSAGES_API_BASE_URL;
  async function post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: input.config.lineHandle, ...body }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        isRecord(payload) && isRecord(payload.error) ? readString(payload.error.message) : null;
      throw new MessagesApiError(
        detail ?? `messages.dev request failed (${response.status}).`,
        response.status,
      );
    }
    return payload as T;
  }
  return {
    sendMessage: (args: { to: string; text: string; replyTo?: string; signal?: AbortSignal }) =>
      post<{ id?: string }>(
        "/messages",
        {
          to: args.to,
          text: args.text,
          ...(args.replyTo ? { reply_to: args.replyTo } : {}),
        },
        args.signal,
      ),
    sendReaction: (args: {
      to: string;
      messageId: string;
      type: ImessageReactionType;
      signal?: AbortSignal;
    }) =>
      post<{ id?: string }>(
        "/reactions",
        { to: args.to, message_id: args.messageId, type: args.type },
        args.signal,
      ),
    startTyping: (args: { to: string; signal?: AbortSignal }) =>
      post<unknown>("/typing", { to: args.to }, args.signal),
  };
}

export class MessagesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MessagesApiError";
  }
}

export type ImessageSendInput = {
  text?: string;
  replyToMessageId?: string;
  reaction?: ImessageReactionType;
};

export const IMESSAGE_TOOL_DESCRIPTION = [
  "Send your reply to the user over iMessage. This is the only way the user hears from you: text you write outside this tool is never delivered.",
  "Write like a sharp friend texting back. Lead with the answer. Short sentences, plain words, no headings, no bullet lists, no markdown, no sign-off. One or two short paragraphs at most; if there is more, send a second message rather than a wall of text.",
  "Set text to send a message. Set reaction to tap back on the user's latest message instead of, or in addition to, replying (love, like, dislike, laugh, emphasize, question). Pass replyToMessageId to thread a reply under a specific earlier message.",
  `At most ${IMESSAGE_MAX_SENDS_PER_TURN} sends per turn, so do not split routine answers.`,
].join("\n");

export const IMESSAGE_TOOL_INPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    text: {
      type: "string" as const,
      description: `Plain text, up to ${IMESSAGE_MAX_TEXT_LENGTH} characters. No markdown.`,
    },
    reaction: {
      type: "string" as const,
      enum: [...IMESSAGE_REACTION_TYPES],
      description: "Tapback to add to the message being answered.",
    },
    replyToMessageId: {
      type: "string" as const,
      description: "Message id to thread this reply under. Defaults to a normal message.",
    },
  },
};

// Surface block appended to the shared system prompt for the personal-agent harness.
export function imessageSystemBlock(input: { inboundMessageId: string | null }) {
  return [
    '<channel name="imessage">',
    "You are the user's personal assistant, reached by text message from their phone. This conversation is one long-running thread; earlier messages may be hours or days old.",
    `Every reply must go through the ${IMESSAGE_TOOL_NAME} tool. Do not write a final answer outside it. When you have nothing to add, react instead of sending a message.`,
    "Be brief and concrete. The user is reading on a phone. Prefer doing the thing over describing it; if a task needs an approval or something only the opencompany app offers, say so in one sentence.",
    ...(input.inboundMessageId
      ? [`The message you are answering has id ${input.inboundMessageId}.`]
      : []),
    "</channel>",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
