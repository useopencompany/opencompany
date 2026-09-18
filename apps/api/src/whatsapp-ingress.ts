import { createHash } from "node:crypto";
import {
  createWhatsappClient,
  isWhatsappBetaNumber,
  isWhatsappReplyWindowOpen,
  parseWhatsappMessages,
  verifyWhatsappSignature,
  type WhatsappClient,
  whatsappConfig,
} from "@opencompany/agent/integrations/whatsapp";
import {
  CHAT_READ_PERMISSION,
  CHAT_WRITE_PERMISSION,
  type ChatApplicationService,
} from "@opencompany/core";
import {
  acceptWhatsappEvent,
  completeWhatsappLink,
  deleteWhatsappBinding,
  findLinkedWhatsappBinding,
  isWhatsappLinkCode,
  touchWhatsappBindingInbound,
} from "@opencompany/db/whatsapp";
import { createLogger } from "@opencompany/observability";

const logger = createLogger({ service: "opencompany-api", runtime: "whatsapp-ingress" });
export type WhatsappIngressService = { webhook(request: Request): Promise<Response> };
export function createWhatsappIngress(input: {
  db: any;
  chat: Pick<ChatApplicationService, "createMessage" | "getConversation">;
  defaultModel: string;
  env?: NodeJS.ProcessEnv;
  client?: WhatsappClient;
  now?: () => Date;
}): WhatsappIngressService {
  return {
    async webhook(request) {
      const env = input.env ?? process.env;
      const config = whatsappConfig(env);
      const secret = env.KAPSO_WEBHOOK_SECRET?.trim();
      if (!config || !secret)
        return Response.json({ error: "WhatsApp is not configured." }, { status: 503 });
      const rawBody = await request.text();
      if (!verifyWhatsappSignature(rawBody, request.headers.get("x-webhook-signature"), secret))
        return Response.json({ error: "Invalid signature." }, { status: 401 });
      let events;
      try {
        events = parseWhatsappMessages(JSON.parse(rawBody), config.phoneNumberId);
      } catch {
        return Response.json({ error: "Malformed payload." }, { status: 400 });
      }
      const client = input.client ?? createWhatsappClient(config);
      try {
        for (const event of events) {
          const now = input.now?.() ?? new Date();
          if (
            !isWhatsappBetaNumber(event.sender) ||
            !isWhatsappReplyWindowOpen(event.receivedAt, now.getTime())
          )
            continue;
          let notice: string | null = null;
          const reply = async (text: string) => {
            notice = text;
          };
          const key = `whatsapp:${createHash("sha256").update(`${config.phoneNumberId}:${event.messageId}`).digest("hex")}`;
          await acceptWhatsappEvent(
            key,
            async (tx) => {
              const linked = await findLinkedWhatsappBinding({ handle: event.sender }, tx);
              if (!linked) {
                if (!isWhatsappLinkCode(event.text)) return;
                const binding = await completeWhatsappLink(
                  { code: event.text, handle: event.sender, model: input.defaultModel, now },
                  tx,
                );
                await reply(
                  binding
                    ? "You're linked to opencompany. Send a text to start. Reply STOP to unlink, or manage your connection under Settings → Channels → WhatsApp."
                    : "That code didn't match. Get a new one in opencompany under Settings → Channels → WhatsApp.",
                );
                return;
              }
              if (/^stop$/i.test(event.text)) {
                await deleteWhatsappBinding({ userWorkosId: linked.binding.userWorkosId }, tx);
                await reply("Your WhatsApp is unlinked. Your conversation remains in opencompany.");
                return;
              }
              if (
                !linked.whatsappEnabled ||
                !linked.workspaceRole ||
                !linked.binding.conversationId
              )
                return;
              if (!event.text) {
                await reply("I can read text messages in this beta. Please type your message.");
                return;
              }
              const actor = {
                userId: linked.binding.userWorkosId,
                workspaceId: linked.binding.workspaceId,
                role: linked.workspaceRole,
                permissions: [CHAT_READ_PERMISSION, CHAT_WRITE_PERMISSION],
                authenticationMethod: "service" as const,
              };
              const conversation = await input.chat.getConversation(
                actor,
                linked.binding.conversationId,
              );
              const result = await input.chat.createMessage(actor, {
                idempotencyKey: key,
                conversationId: conversation.id,
                content: event.text,
                engine: conversation.engine,
                model: conversation.model,
                settings: { whatsapp: event },
              });
              if (!result.idempotentReplay)
                await touchWhatsappBindingInbound(
                  { bindingId: linked.binding.id, at: new Date(event.receivedAt) },
                  tx,
                );
            },
            input.db,
          );
          if (notice) {
            try {
              await client.sendMessage({
                to: event.sender,
                text: notice,
                replyTo: event.messageId,
              });
            } catch {
              logger.warn("WhatsApp notice could not be sent", {
                event: "opencompany.whatsapp_notice_failed",
              });
            }
          }
        }
        return Response.json({ ok: true });
      } catch {
        logger.error("WhatsApp event persistence failed", {
          event: "opencompany.whatsapp_ingress_failed",
        });
        return Response.json({ error: "Event persistence failed." }, { status: 503 });
      }
    },
  };
}
