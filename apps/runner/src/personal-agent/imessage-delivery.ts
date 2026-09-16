import type { ActionDispatcher } from "@opencompany/agent/chat-agent";
import {
  createMessagesClient,
  IMESSAGE_MAX_SENDS_PER_TURN,
  IMESSAGE_MAX_TEXT_LENGTH,
  IMESSAGE_REACTION_TYPES,
  IMESSAGE_TOOL_DESCRIPTION,
  IMESSAGE_TOOL_INPUT_SCHEMA,
  IMESSAGE_TOOL_NAME,
  type ImessageConfig,
  type ImessageReactionType,
  type ImessageSendInput,
  type MessagesClient,
} from "@opencompany/agent/integrations/imessage";
import { createLogger } from "@opencompany/observability";
import { jsonSchema, type ToolSet, tool } from "ai";

const logger = createLogger({ service: "opencompany-runner", runtime: "goat-personal-agent" });

// What the webhook stamps on a Run that a text message started. Absent on a Run the member typed
// in the web app, which then answers in the Conversation instead of on the phone.
export type ImessageInboundSettings = {
  deliveryId: string;
  messageId: string;
  chatId: string | null;
  sender: string;
};

export function readImessageInboundSettings(
  settings: Record<string, unknown> | undefined,
): ImessageInboundSettings | null {
  const value = settings?.imessage;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const deliveryId = typeof record.deliveryId === "string" ? record.deliveryId : "";
  const messageId = typeof record.messageId === "string" ? record.messageId : "";
  const sender = typeof record.sender === "string" ? record.sender : "";
  if (!deliveryId || !messageId || !sender) return null;
  return {
    deliveryId,
    messageId,
    sender,
    chatId: typeof record.chatId === "string" ? record.chatId : null,
  };
}

export type ImessageSendOutput =
  | { ok: true; outboxId: string | null; reaction: ImessageReactionType | null }
  | { ok: false; error: string };

// One delivery per turn: owns the send budget, the tool the model sees, and the fallback that
// keeps a phone from going silent when the model answers in plain text instead of using the tool.
export function createImessageDelivery(input: {
  config: ImessageConfig;
  handle: string;
  inbound: ImessageInboundSettings;
  signal: AbortSignal;
  client?: MessagesClient;
}) {
  const client = input.client ?? createMessagesClient({ config: input.config });
  let sends = 0;
  let delivered = false;

  const send = async (args: ImessageSendInput): Promise<ImessageSendOutput> => {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    const reaction =
      args.reaction && IMESSAGE_REACTION_TYPES.includes(args.reaction) ? args.reaction : null;
    if (!text && !reaction) return { ok: false, error: "Provide text, a reaction, or both." };
    if (text.length > IMESSAGE_MAX_TEXT_LENGTH) {
      return {
        ok: false,
        error: `Text is over ${IMESSAGE_MAX_TEXT_LENGTH} characters. Shorten it or split it.`,
      };
    }
    if (sends >= IMESSAGE_MAX_SENDS_PER_TURN) {
      return { ok: false, error: "Send limit reached for this turn. Stop here." };
    }
    sends += 1;
    const targetMessageId = args.replyToMessageId?.trim() || input.inbound.messageId;
    try {
      if (reaction) {
        await client.sendReaction({
          to: input.handle,
          messageId: targetMessageId,
          type: reaction,
          signal: input.signal,
        });
        delivered = true;
      }
      let outboxId: string | null = null;
      if (text) {
        const sent = await client.sendMessage({
          to: input.handle,
          text,
          ...(args.replyToMessageId?.trim() ? { replyTo: args.replyToMessageId.trim() } : {}),
          signal: input.signal,
        });
        // messages.dev writes asynchronously: POST /messages returns an `obx_...` outbox item,
        // not the eventual `msg_...` message id used for reply threading.
        outboxId = typeof sent?.id === "string" ? sent.id : null;
        delivered = true;
      }
      return { ok: true, outboxId, reaction };
    } catch (error) {
      logger.warn("iMessage send failed", {
        event: "opencompany.personal_agent_imessage_send_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        error: error instanceof Error ? error.message : "The message could not be sent.",
      };
    }
  };

  return {
    tools: {
      [IMESSAGE_TOOL_NAME]: tool<ImessageSendInput, ImessageSendOutput, Record<string, unknown>>({
        description: IMESSAGE_TOOL_DESCRIPTION,
        inputSchema: jsonSchema<ImessageSendInput>(IMESSAGE_TOOL_INPUT_SCHEMA),
        execute: (args) => send(args),
      }),
    } satisfies ToolSet,
    delivered: () => delivered,
    startTyping: () => {
      client.startTyping({ to: input.handle, signal: input.signal }).catch((error: unknown) =>
        logger.info("iMessage typing indicator failed", {
          event: "opencompany.personal_agent_imessage_typing_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
    // Text the model wrote outside the tool, or a terminal failure notice. Bypasses the per-turn
    // send budget because it runs once, after the model is done.
    sendFallback: async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      try {
        await client.sendMessage({
          to: input.handle,
          text: trimmed.slice(0, IMESSAGE_MAX_TEXT_LENGTH),
          signal: input.signal,
        });
        delivered = true;
      } catch (error) {
        logger.warn("iMessage fallback send failed", {
          event: "opencompany.personal_agent_imessage_fallback_failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export type ImessageDelivery = ReturnType<typeof createImessageDelivery>;

// Approvals live in the opencompany app; a phone has no way to answer one. Instead of pausing the
// Run, an action that would need approval fails with a message the model relays to the user.
export function withoutActionApprovals(dispatcher: ActionDispatcher): ActionDispatcher {
  const { needsApproval, ...rest } = dispatcher;
  if (!needsApproval) return dispatcher;
  return {
    ...rest,
    execute: async (call) => {
      if (await needsApproval(call)) {
        return {
          ok: false,
          action: call.action,
          error: {
            code: "internal",
            message:
              "This action needs your approval in the opencompany app, and approvals are not available over iMessage yet. Tell the user what you wanted to do and that they can run it from the app.",
          },
        };
      }
      return dispatcher.execute(call);
    },
  };
}
