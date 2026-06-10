import { newAgentSessionId, newAgentSessionMessageId } from "@opencompany/agent-runtime";
import { hasPositiveWorkspaceBalance } from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import {
  agentSessionEvents,
  agentSessionMessages,
  agentSessions,
  agents,
  type MessagingChannel,
  messagingChannels,
  messagingMessages,
} from "@opencompany/db/schema";
import type { InboundTextMessage, MessagingProvider } from "@opencompany/messaging";
import { createLogger } from "@opencompany/observability";
import { and, eq, gt } from "drizzle-orm";
import { appendSessionStreamEvent } from "@/lib/agent-sessions/durable-streams";
import { dispatchAgentAfterSessionCheck } from "@/lib/agent-sessions/events";
import { triggerAgentMessageRun } from "@/lib/agent-sessions/message-runner";
import { dispatchDeliverWhatsappReply } from "@/lib/messaging/events";
import { newMessagingMessageId } from "@/lib/messaging/ids";

const WHATSAPP_PROVIDER = "whatsapp";
// A fresh inbound message hard-starts a new session once the prior one has been idle this long.
const SESSION_IDLE_WINDOW_MS = 6 * 60 * 60 * 1000;
const PREVIEW_MAX = 200;

const REPLY_CONNECTED =
  "✅ You're connected to OpenCompany. I'm your personal agent — message me anytime.";
const REPLY_NOT_LINKED =
  "👋 This number isn't linked to OpenCompany yet. Open the app → Channels → Connect WhatsApp to get started.";
const REPLY_NO_CREDITS =
  "⚠️ Your workspace is out of credits. Add credits in OpenCompany to keep chatting.";

const logger = createLogger({ service: "opencompany-web", runtime: "server" });

// Entry point for one inbound WhatsApp text. Idempotent against provider webhook retries, routes a
// linked sender into their personal agent, completes a pending link, or replies that the number is
// not linked. The reply path uses `provider.sendText` directly (fast); the AGENT reply is delivered
// asynchronously by the Inngest delivery job this enqueues.
export async function handleInboundWhatsApp(
  provider: MessagingProvider,
  message: InboundTextMessage,
): Promise<void> {
  // Claim the provider message id first so a redelivery loses the race and is skipped — this is the
  // single guard that prevents double-running the agent on Meta's webhook retries.
  const inboundId = await claimInboundMessage(message);
  if (!inboundId) return;

  const text = message.text.trim();

  // 1. Already linked → route into the personal agent.
  const channel = await findConnectedChannel(message.from);
  if (channel) {
    await ingestLinkedMessage({ provider, inboundId, channel, message, text });
    return;
  }

  // 2. A link attempt ("link <token>") from a not-yet-bound number.
  const token = parseLinkToken(text);
  if (token) {
    const bound = await bindChannelFromLinkToken({ token, message });
    if (bound) {
      await finalizeInbound(inboundId, { channelId: bound.id, status: "linked" });
      await sendAndRecord({ provider, channel: bound, to: message.from, text: REPLY_CONNECTED });
      return;
    }
  }

  // 3. Unknown / not linked.
  await finalizeInbound(inboundId, { channelId: null, status: "unlinked" });
  await sendAndRecord({ provider, channel: null, to: message.from, text: REPLY_NOT_LINKED });
}

async function ingestLinkedMessage(input: {
  provider: MessagingProvider;
  inboundId: string;
  channel: MessagingChannel;
  message: InboundTextMessage;
  text: string;
}): Promise<void> {
  const { provider, inboundId, channel, message, text } = input;
  const db = getDb();

  if (!(await hasPositiveWorkspaceBalance({ db, workspaceId: channel.workspaceId }))) {
    await finalizeInbound(inboundId, { channelId: channel.id, status: "received" });
    await sendAndRecord({ provider, channel, to: message.from, text: REPLY_NO_CREDITS });
    return;
  }

  const sessionId = await routeSession(channel);
  const userMessageId = await insertChannelUserMessage(sessionId, text);

  await db
    .update(messagingChannels)
    .set({
      activeSessionId: sessionId,
      lastInboundAt: new Date(),
      // Keep the profile name fresh from the latest inbound contact payload.
      ...(message.profileName ? { profileName: message.profileName } : {}),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(messagingChannels.id, channel.id));

  // Link the inbound log row to the agent USER message so the backstop sweep can resolve the
  // recipient for an undelivered reply (reply.responseToMessageId === this agentMessageId).
  await finalizeInbound(inboundId, {
    channelId: channel.id,
    sessionId,
    agentMessageId: userMessageId,
    status: "received",
  });

  await Promise.all([
    triggerAgentMessageRun({
      sessionId,
      messageId: userMessageId,
      workspaceId: channel.workspaceId,
    }),
    dispatchAgentAfterSessionCheck({
      sessionId,
      messageId: userMessageId,
      workspaceId: channel.workspaceId,
    }),
    dispatchDeliverWhatsappReply({
      channelId: channel.id,
      sessionId,
      userMessageId,
      to: message.from,
      workspaceId: channel.workspaceId,
    }),
  ]);
}

// Resolve which session this inbound message belongs to. Reuse the channel's active session while it
// has been active within the idle window and is still usable; otherwise hard-start a fresh one.
async function routeSession(channel: MessagingChannel): Promise<string> {
  const db = getDb();
  const withinWindow =
    channel.activeSessionId &&
    channel.lastInboundAt &&
    Date.now() - channel.lastInboundAt.getTime() <= SESSION_IDLE_WINDOW_MS;

  if (withinWindow && channel.activeSessionId) {
    const [existing] = await db
      .select({ id: agentSessions.id, archivedAt: agentSessions.archivedAt })
      .from(agentSessions)
      .where(eq(agentSessions.id, channel.activeSessionId))
      .limit(1);
    if (existing && !existing.archivedAt) return existing.id;
  }

  return createChannelSession(channel);
}

async function createChannelSession(channel: MessagingChannel): Promise<string> {
  const db = getDb();
  const [agent] = await db
    .select({ config: agents.config })
    .from(agents)
    .where(eq(agents.id, channel.agentId))
    .limit(1);

  const model = agent?.config?.model;
  const sessionId = newAgentSessionId();

  await db.batch([
    db.insert(agentSessions).values({
      id: sessionId,
      workspaceId: channel.workspaceId,
      userId: channel.userId,
      agentId: channel.agentId,
      title: "WhatsApp",
      // Marks the thread as WhatsApp-originated for the unified sidebar badge + source filter.
      source: "whatsapp",
      ...(model?.provider ? { modelProvider: model.provider } : {}),
      ...(model?.name ? { modelName: model.name } : {}),
    }),
    db.insert(agentSessionEvents).values({
      sessionId,
      type: "session.status",
      payload: { status: "created", message: "Session created" },
    }),
  ]);

  return sessionId;
}

// Insert a user message onto a session. Mirrors agent-sessions/actions.insertUserMessage (batched
// message + event, plus a best-effort Durable Stream mirror so a stream-sourced transcript shows
// it). Returns the new message id.
async function insertChannelUserMessage(sessionId: string, content: string): Promise<string> {
  const db = getDb();
  const messageId = newAgentSessionMessageId();
  const payload = { messageId, role: "user", content, status: "completed" };

  const [, eventRows] = await db.batch([
    db.insert(agentSessionMessages).values({
      id: messageId,
      sessionId,
      role: "user",
      status: "completed",
      content,
      modelMessage: { role: "user", content },
      completedAt: new Date(),
    }),
    db
      .insert(agentSessionEvents)
      .values({ sessionId, messageId, type: "message.created", payload })
      .returning({ id: agentSessionEvents.id, createdAt: agentSessionEvents.createdAt }),
  ]);

  const eventRow = eventRows[0];
  if (eventRow) {
    await appendSessionStreamEvent(sessionId, {
      id: eventRow.id,
      type: "message.created",
      messageId,
      payload,
      createdAt: eventRow.createdAt.toISOString(),
    });
  }

  return messageId;
}

async function findConnectedChannel(externalId: string): Promise<MessagingChannel | null> {
  const db = getDb();
  const [channel] = await db
    .select()
    .from(messagingChannels)
    .where(
      and(
        eq(messagingChannels.provider, WHATSAPP_PROVIDER),
        eq(messagingChannels.externalId, externalId),
        eq(messagingChannels.status, "connected"),
      ),
    )
    .limit(1);
  return channel ?? null;
}

// Atomically bind a pending channel whose link token matches and hasn't expired. Status-guarded so
// only a genuine pending_link row binds; returns null on no match (bad/expired token) or if the
// number is already bound elsewhere (the partial-unique index throws → caught).
async function bindChannelFromLinkToken(input: {
  token: string;
  message: InboundTextMessage;
}): Promise<MessagingChannel | null> {
  const db = getDb();
  const now = new Date();
  try {
    const [bound] = await db
      .update(messagingChannels)
      .set({
        status: "connected",
        externalId: input.message.from,
        profileName: input.message.profileName ?? null,
        linkToken: null,
        linkTokenExpiresAt: null,
        lastInboundAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(messagingChannels.provider, WHATSAPP_PROVIDER),
          eq(messagingChannels.linkToken, input.token),
          eq(messagingChannels.status, "pending_link"),
          gt(messagingChannels.linkTokenExpiresAt, now),
        ),
      )
      .returning();
    return bound ?? null;
  } catch (error) {
    logger.warn("WhatsApp link binding failed", {
      event: "opencompany.whatsapp_link_bind_failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// Claim the inbound provider message id (dedupe key). Returns the new row id, or null if a row for
// this provider message id already exists (a webhook retry we must not reprocess).
async function claimInboundMessage(message: InboundTextMessage): Promise<string | null> {
  const db = getDb();
  const id = newMessagingMessageId();
  const inserted = await db
    .insert(messagingMessages)
    .values({
      id,
      channelId: null,
      provider: WHATSAPP_PROVIDER,
      direction: "inbound",
      externalContactId: message.from,
      providerMessageId: message.providerMessageId,
      status: "received",
      preview: preview(message.text),
    })
    .onConflictDoNothing({ target: messagingMessages.providerMessageId })
    .returning({ id: messagingMessages.id });
  return inserted[0]?.id ?? null;
}

async function finalizeInbound(
  inboundId: string,
  fields: {
    channelId: string | null;
    sessionId?: string;
    agentMessageId?: string;
    status: string;
  },
): Promise<void> {
  const db = getDb();
  await db
    .update(messagingMessages)
    .set({
      channelId: fields.channelId,
      ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
      ...(fields.agentMessageId ? { agentMessageId: fields.agentMessageId } : {}),
      status: fields.status,
    })
    .where(eq(messagingMessages.id, inboundId));
}

// Send an outbound message and record it. Best-effort: a send failure is logged and the channel's
// lastError is stamped, but never thrown to the webhook (Meta would otherwise retry the whole POST).
async function sendAndRecord(input: {
  provider: MessagingProvider;
  channel: MessagingChannel | null;
  to: string;
  text: string;
}): Promise<void> {
  const db = getDb();
  try {
    const result = await input.provider.sendText({ to: input.to, text: input.text });
    await db.insert(messagingMessages).values({
      id: newMessagingMessageId(),
      channelId: input.channel?.id ?? null,
      provider: WHATSAPP_PROVIDER,
      direction: "outbound",
      externalContactId: input.to,
      providerMessageId: result.providerMessageId,
      status: "sent",
      preview: preview(input.text),
    });
    if (input.channel) {
      await db
        .update(messagingChannels)
        .set({ lastOutboundAt: new Date(), updatedAt: new Date() })
        .where(eq(messagingChannels.id, input.channel.id));
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    logger.warn("WhatsApp send failed", {
      event: "opencompany.whatsapp_send_failed",
      error: messageText,
    });
    await db.insert(messagingMessages).values({
      id: newMessagingMessageId(),
      channelId: input.channel?.id ?? null,
      provider: WHATSAPP_PROVIDER,
      direction: "outbound",
      externalContactId: input.to,
      status: "failed",
      preview: preview(input.text),
      error: messageText,
    });
    if (input.channel) {
      await db
        .update(messagingChannels)
        .set({ lastError: messageText, updatedAt: new Date() })
        .where(eq(messagingChannels.id, input.channel.id));
    }
  }
}

// Recognize "link <token>" (case-insensitive, tolerant of extra whitespace) and return the token.
function parseLinkToken(text: string): string | null {
  const match = text.match(/^link\s+(\S+)$/i);
  return match?.[1] ?? null;
}

function preview(text: string): string {
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}
