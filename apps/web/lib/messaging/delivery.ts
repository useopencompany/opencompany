import { getDb } from "@opencompany/db/client";
import {
  agentSessionMessages,
  agentSessions,
  messagingChannels,
  messagingMessages,
} from "@opencompany/db/schema";
import type { MessagingProvider } from "@opencompany/messaging";
import { and, eq, gt, isNotNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getWhatsAppProvider } from "@/lib/messaging/config";
import type { DeliverWhatsappReplyInput } from "@/lib/messaging/events";
import { newMessagingMessageId } from "@/lib/messaging/ids";

const WHATSAPP_PROVIDER = "whatsapp";
const PREVIEW_MAX = 200;
// WhatsApp text bodies are capped at 4096 chars; clamp longer agent replies.
const WHATSAPP_TEXT_LIMIT = 4096;
// Poll cadence for a fresh reply. ~2 min of coverage; anything slower is caught by the sweep.
const MAX_POLLS = 30;
const POLL_INTERVAL = "4s";
// Backstop only re-delivers replies that completed recently, so an old undelivered thread doesn't
// suddenly spam the user after a long outage.
const SWEEP_LOOKBACK_MS = 60 * 60 * 1000;

const TERMINAL_FAILURE_STATUSES = new Set(["failed", "aborted", "interrupted", "archived"]);

// Minimal step surface so this logic stays unit-testable and decoupled from the Inngest types.
type WorkflowStep = {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, duration: string): Promise<void>;
};

// Per-message delivery: poll for the completed assistant reply, then send it. Enqueued by the
// inbound webhook right after the agent run is triggered.
export async function runDeliverWhatsappReply(input: {
  data: DeliverWhatsappReplyInput;
  step: WorkflowStep;
}): Promise<{ delivered: boolean; reason?: string }> {
  const provider = getWhatsAppProvider();
  if (!provider) return { delivered: false, reason: "not_configured" };
  const { data, step } = input;

  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    const status = await step.run(`poll-${attempt}`, () => loadReplyStatus(data));
    if (status.kind === "ready") {
      return step.run(`send-${attempt}`, () =>
        deliverReply({
          provider,
          to: data.to,
          channelId: data.channelId,
          sessionId: data.sessionId,
          reply: status.reply,
        }),
      );
    }
    if (status.kind === "failed") {
      return step.run(`send-error-${attempt}`, () => deliverError({ provider, data }));
    }
    await step.sleep(`wait-${attempt}`, POLL_INTERVAL);
  }
  return { delivered: false, reason: "timeout" };
}

// Backstop sweep: deliver any recently-completed WhatsApp reply that has no outbound row yet.
export async function runWhatsappDeliverySweep(
  step: WorkflowStep,
): Promise<{ scanned: number; delivered: number }> {
  const provider = getWhatsAppProvider();
  if (!provider) return { scanned: 0, delivered: 0 };

  const candidates = await step.run("select undelivered replies", () => loadUndeliveredReplies());
  let delivered = 0;
  for (const candidate of candidates) {
    const result = await step.run(`deliver ${candidate.replyId}`, () =>
      deliverReply({
        provider,
        to: candidate.to,
        channelId: candidate.channelId,
        sessionId: candidate.sessionId,
        reply: { id: candidate.replyId, content: candidate.content },
      }),
    );
    if (result.delivered) delivered += 1;
  }
  return { scanned: candidates.length, delivered };
}

type ReplyStatus =
  | { kind: "ready"; reply: { id: string; content: string } }
  | { kind: "failed" }
  | { kind: "pending" };

async function loadReplyStatus(data: DeliverWhatsappReplyInput): Promise<ReplyStatus> {
  const db = getDb();
  const [reply] = await db
    .select({
      id: agentSessionMessages.id,
      content: agentSessionMessages.content,
      status: agentSessionMessages.status,
    })
    .from(agentSessionMessages)
    .where(
      and(
        eq(agentSessionMessages.responseToMessageId, data.userMessageId),
        eq(agentSessionMessages.role, "assistant"),
      ),
    )
    .limit(1);

  if (reply?.status === "completed")
    return { kind: "ready", reply: { id: reply.id, content: reply.content } };
  if (reply?.status === "failed") return { kind: "failed" };

  const [session] = await db
    .select({ status: agentSessions.status })
    .from(agentSessions)
    .where(eq(agentSessions.id, data.sessionId))
    .limit(1);
  if (session && TERMINAL_FAILURE_STATUSES.has(session.status)) return { kind: "failed" };

  return { kind: "pending" };
}

async function deliverReply(input: {
  provider: MessagingProvider;
  to: string;
  channelId: string;
  sessionId: string;
  reply: { id: string; content: string };
}): Promise<{ delivered: boolean; reason?: string }> {
  const db = getDb();

  // Idempotency: never send the same assistant message twice (the per-message job and the sweep can
  // both reach a reply).
  if (await outboundExists(input.reply.id)) return { delivered: true, reason: "already" };

  const text = input.reply.content.trim();
  if (!text) return { delivered: false, reason: "empty" };

  const result = await input.provider.sendText({ to: input.to, text: clamp(text) });
  await db.insert(messagingMessages).values({
    id: newMessagingMessageId(),
    channelId: input.channelId,
    provider: WHATSAPP_PROVIDER,
    direction: "outbound",
    externalContactId: input.to,
    providerMessageId: result.providerMessageId,
    sessionId: input.sessionId,
    agentMessageId: input.reply.id,
    status: "sent",
    preview: preview(text),
  });
  await db
    .update(messagingChannels)
    .set({ lastOutboundAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(messagingChannels.id, input.channelId));

  return { delivered: true };
}

async function deliverError(input: {
  provider: MessagingProvider;
  data: DeliverWhatsappReplyInput;
}): Promise<{ delivered: boolean; reason?: string }> {
  const db = getDb();
  try {
    await input.provider.sendText({
      to: input.data.to,
      text: "⚠️ Something went wrong handling that. Please try again.",
    });
    await db.insert(messagingMessages).values({
      id: newMessagingMessageId(),
      channelId: input.data.channelId,
      provider: WHATSAPP_PROVIDER,
      direction: "outbound",
      externalContactId: input.data.to,
      sessionId: input.data.sessionId,
      status: "sent",
      preview: "agent run failed",
    });
  } catch {
    // Best-effort: a failed error-notification must not fail the delivery job.
  }
  return { delivered: false, reason: "agent_failed" };
}

async function outboundExists(agentMessageId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: messagingMessages.id })
    .from(messagingMessages)
    .where(
      and(
        eq(messagingMessages.agentMessageId, agentMessageId),
        eq(messagingMessages.direction, "outbound"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function loadUndeliveredReplies(): Promise<
  Array<{ replyId: string; content: string; sessionId: string; channelId: string; to: string }>
> {
  const db = getDb();
  const cutoff = new Date(Date.now() - SWEEP_LOOKBACK_MS);
  const inbound = alias(messagingMessages, "inbound");
  const outbound = alias(messagingMessages, "outbound");

  const rows = await db
    .select({
      replyId: agentSessionMessages.id,
      content: agentSessionMessages.content,
      sessionId: inbound.sessionId,
      channelId: inbound.channelId,
      to: inbound.externalContactId,
    })
    .from(agentSessionMessages)
    // The inbound log row carries the recipient + channel; reply.responseToMessageId points at the
    // agent USER message id we stored on it (see finalizeInbound).
    .innerJoin(inbound, eq(inbound.agentMessageId, agentSessionMessages.responseToMessageId))
    .where(
      and(
        eq(agentSessionMessages.role, "assistant"),
        eq(agentSessionMessages.status, "completed"),
        gt(agentSessionMessages.completedAt, cutoff),
        eq(inbound.direction, "inbound"),
        isNotNull(inbound.channelId),
        isNotNull(inbound.sessionId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(outbound)
            .where(
              and(
                eq(outbound.agentMessageId, agentSessionMessages.id),
                eq(outbound.direction, "outbound"),
              ),
            ),
        ),
      ),
    )
    .limit(50);

  return rows.filter(
    (
      row,
    ): row is {
      replyId: string;
      content: string;
      sessionId: string;
      channelId: string;
      to: string;
    } => Boolean(row.channelId) && Boolean(row.sessionId) && Boolean(row.to),
  );
}

function clamp(text: string): string {
  return text.length > WHATSAPP_TEXT_LIMIT ? `${text.slice(0, WHATSAPP_TEXT_LIMIT - 1)}…` : text;
}

function preview(text: string): string {
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
}
