import {
  createWhatsappClient,
  isWhatsappReplyWindowOpen,
  readWhatsappInboundSettings,
  WHATSAPP_MAX_TEXT_LENGTH,
  type WhatsappClient,
  type WhatsappConfig,
} from "@opencompany/agent/integrations/whatsapp";
import { getDb } from "@opencompany/db/client";
import { whatsappSendAttempts } from "@opencompany/db/product-schema";
import { findLinkedWhatsappBinding } from "@opencompany/db/whatsapp";
import { jsonSchema, tool } from "ai";
import { eq } from "drizzle-orm";
import type { PersonalAgentDelivery } from "./delivery";

export { readWhatsappInboundSettings };

export function createWhatsappSendStore(db = getDb()) {
  return {
    async claim(id: string) {
      const rows = await db
        .insert(whatsappSendAttempts)
        .values({ id, status: "pending" })
        .onConflictDoNothing()
        .returning({ id: whatsappSendAttempts.id });
      return rows.length === 1;
    },
    async settle(id: string, status: "accepted" | "failed", providerMessageId?: string) {
      await db
        .update(whatsappSendAttempts)
        .set({ status, providerMessageId: providerMessageId ?? null, updatedAt: new Date() })
        .where(eq(whatsappSendAttempts.id, id));
    },
  };
}

export function createWhatsappDelivery(input: {
  config: WhatsappConfig;
  inbound: NonNullable<ReturnType<typeof readWhatsappInboundSettings>>;
  turnId: string;
  conversationId: string;
  userWorkosId: string;
  workspaceId: string;
  signal: AbortSignal;
  client?: WhatsappClient;
  store?: ReturnType<typeof createWhatsappSendStore>;
  authorize?: () => Promise<boolean>;
  now?: () => number;
}): PersonalAgentDelivery {
  const client = input.client ?? createWhatsappClient(input.config);
  const store = input.store ?? createWhatsappSendStore();
  let sends = 0;
  let attempted = false;
  let blocked = false;
  const authorize =
    input.authorize ??
    (async () => {
      const linked = await findLinkedWhatsappBinding({ handle: input.inbound.sender });
      return Boolean(
        linked?.whatsappEnabled &&
          linked.workspaceRole &&
          linked.binding.userWorkosId === input.userWorkosId &&
          linked.binding.workspaceId === input.workspaceId &&
          linked.binding.conversationId === input.conversationId,
      );
    });
  async function send(text: string) {
    if (blocked) {
      attempted = true;
      blocked = true;
      return {
        ok: false,
        error: "A reply was already attempted for this turn. Do not send it again.",
      };
    }
    if (!isWhatsappReplyWindowOpen(input.inbound.receivedAt, input.now?.())) {
      attempted = true;
      return {
        ok: false,
        error: "The WhatsApp reply window expired. The answer is available in the app.",
      };
    }
    if (!(await authorize())) {
      attempted = true;
      return { ok: false, error: "This WhatsApp connection is no longer active." };
    }
    // Claim before the network call. On a lost response or process restart, we cannot know if
    // WhatsApp received it, so the same slot must never be blindly submitted a second time.
    const key = `${input.turnId}:reply`;
    if (!(await store.claim(key))) {
      attempted = true;
      blocked = true;
      return {
        ok: false,
        error: "This reply was already attempted. Check its result in the app; do not resend it.",
      };
    }
    attempted = true;
    try {
      const sent = await client.sendMessage({
        to: input.inbound.sender,
        text,
        replyTo: input.inbound.messageId,
        signal: input.signal,
      });
      await store.settle(key, "accepted", sent.id);
      return { ok: true, messageId: sent.id };
    } catch {
      blocked = true;
      await store.settle(key, "failed");
      return {
        ok: false,
        error:
          "The WhatsApp reply could not be confirmed. Do not resend it automatically; the answer remains in the app.",
      };
    }
  }
  return {
    systemBlock:
      '<channel name="whatsapp">You are replying to a WhatsApp text. Use whatsapp_send for your answer. Keep it short, plain and useful. Send one message of at most 4096 characters. The destination is fixed to this user. Text only; no attachments, groups or proactive messages. If a send fails, explain the result in the app and do not repeat the send.</channel>',
    tools: {
      whatsapp_send: tool({
        description:
          "Reply by text to the WhatsApp user who started this turn. The recipient is fixed. One reply per turn, up to 4096 characters.",
        inputSchema: jsonSchema<{ text: string }>({
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, maxLength: WHATSAPP_MAX_TEXT_LENGTH },
          },
          required: ["text"],
          additionalProperties: false,
        }),
        execute: async ({ text }) => {
          if (!text?.trim() || text.length > WHATSAPP_MAX_TEXT_LENGTH)
            return { ok: false, error: "Provide a text reply of 1–4096 characters." };
          if (sends >= 1) return { ok: false, error: "Send limit reached for this turn." };
          sends += 1;
          return send(text);
        },
      }),
    },
    hasReply: () => attempted,
    startTyping: () => {},
    async sendFallback(text) {
      if (!text.trim() || attempted) return;
      const result = await send(text.trim().slice(0, WHATSAPP_MAX_TEXT_LENGTH));
      if (!result.ok) throw new Error(result.error);
    },
  };
}
