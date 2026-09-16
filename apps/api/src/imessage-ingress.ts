import {
  createMessagesClient,
  imessageConfig,
  imessageWebhookSecret,
  type MessagesClient,
  parseImessageReceivedEvent,
  verifyImessageWebhookSignature,
} from "@opencompany/agent/integrations/imessage";
import {
  CHAT_READ_PERMISSION,
  CHAT_WRITE_PERMISSION,
  type ChatApplicationService,
} from "@opencompany/core";
import {
  completeImessageLink,
  findLinkedImessageBinding,
  isImessageLinkCode,
  touchImessageBindingInbound,
} from "@opencompany/db/imessage";
import { createLogger } from "@opencompany/observability";

const logger = createLogger({ service: "opencompany-api", runtime: "imessage-ingress" });

type DbLike = any;

const LINKED_REPLY =
  "You're linked to opencompany. Text me anything: a question, a task, something to look up.";
const BAD_CODE_REPLY =
  "That code didn't match. Get a new one in opencompany under Settings → Channels → iMessage.";
const DISABLED_REPLY =
  "Your opencompany account can't use iMessage right now. Check Settings → Channels → iMessage in the app.";
const TEXT_ONLY_REPLY = "I can only read text for now. Type it out and I'll take it from there.";

export type ImessageIngressService = {
  webhook(request: Request): Promise<Response>;
};

// messages.dev → opencompany. Two jobs: pair a phone that texts a live link code, and turn a text
// from a paired phone into a Message on that member's personal-agent Conversation. Every Run is
// keyed on the provider delivery id, so a redelivered webhook never starts a second Run.
export function createImessageIngress(input: {
  db: DbLike;
  chat: Pick<ChatApplicationService, "createMessage" | "getConversation">;
  defaultModel: string;
  env?: NodeJS.ProcessEnv;
  client?: MessagesClient;
  now?: () => Date;
}): ImessageIngressService {
  const env = input.env ?? process.env;
  return {
    webhook: (request) => handleWebhook(input, env, request),
  };
}

async function handleWebhook(
  input: Parameters<typeof createImessageIngress>[0],
  env: NodeJS.ProcessEnv,
  request: Request,
): Promise<Response> {
  const secret = imessageWebhookSecret(env);
  const config = imessageConfig(env);
  if (!secret || !config) {
    return Response.json({ error: "iMessage is not configured." }, { status: 503 });
  }
  const rawBody = await request.text();
  if (
    !verifyImessageWebhookSignature({
      rawBody,
      timestamp: request.headers.get("x-webhook-timestamp"),
      signature: request.headers.get("x-webhook-signature"),
      secret,
      ...(input.now ? { nowMs: input.now().getTime() } : {}),
    })
  ) {
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Malformed payload." }, { status: 400 });
  }
  const event = parseImessageReceivedEvent(envelope, request.headers.get("x-webhook-delivery-id"));
  if (!event || event.isFromMe) return Response.json({ ok: true, ignored: true });

  const client = input.client ?? createMessagesClient({ config });
  const reply = (text: string) =>
    client.sendMessage({ to: event.sender, text }).catch((error: unknown) =>
      logger.warn("iMessage notice could not be sent", {
        event: "goat.imessage_notice_failed",
        error_message: error instanceof Error ? error.message : String(error),
      }),
    );

  try {
    const linked = await findLinkedImessageBinding({ handle: event.sender }, input.db);
    if (!linked) {
      // Only a text that looks like a code gets an answer: an unknown number texting anything
      // else is silently ignored rather than handed a conversation with a stranger's bot.
      if (!isImessageLinkCode(event.text)) return Response.json({ ok: true, ignored: true });
      const binding = await completeImessageLink(
        { code: event.text, handle: event.sender, model: input.defaultModel },
        input.db,
      );
      await reply(binding ? LINKED_REPLY : BAD_CODE_REPLY);
      return Response.json({ ok: true, linked: Boolean(binding) });
    }
    if (!linked.imessageEnabled || !linked.workspaceRole || !linked.binding.conversationId) {
      await reply(DISABLED_REPLY);
      return Response.json({ ok: true, ignored: true });
    }
    if (!event.text) {
      await reply(TEXT_ONLY_REPLY);
      return Response.json({ ok: true, ignored: true });
    }
    const actor = {
      userId: linked.binding.userWorkosId,
      workspaceId: linked.binding.workspaceId,
      role: linked.workspaceRole,
      // Reading the Conversation for its engine and model needs chat:read; queuing the Message
      // needs chat:write.
      permissions: [CHAT_READ_PERMISSION, CHAT_WRITE_PERMISSION],
      authenticationMethod: "service" as const,
    };
    const conversation = await input.chat.getConversation(actor, linked.binding.conversationId);
    const result = await input.chat.createMessage(actor, {
      idempotencyKey: `imessage:${event.deliveryId}`.slice(0, 200),
      conversationId: conversation.id,
      content: event.text,
      engine: conversation.engine,
      model: conversation.model,
      settings: {
        imessage: {
          deliveryId: event.deliveryId,
          messageId: event.messageId,
          chatId: event.chatId,
          sender: event.sender,
        },
      },
    });
    if (!result.idempotentReplay) {
      await touchImessageBindingInbound({ bindingId: linked.binding.id }, input.db);
    }
    return Response.json({ ok: true, runId: result.runId, replayed: result.idempotentReplay });
  } catch (error) {
    logger.error("Failed to accept iMessage event", {
      event: "goat.imessage_event_failed",
      delivery_id: event.deliveryId,
      error_message: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "Event persistence failed." }, { status: 503 });
  }
}
