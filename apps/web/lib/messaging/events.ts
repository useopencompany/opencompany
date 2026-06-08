import { inngest } from "@/lib/inngest/client";

// Outbound delivery is driven entirely on the web side (the runner stays generic and never learns
// about channels). The inbound webhook enqueues this event right after triggering the agent run;
// the handler polls for the completed assistant reply and sends it over the Cloud API.
export const WHATSAPP_DELIVER_REPLY_EVENT = "messaging.whatsapp.deliver_reply";

// Backstop sweep cadence: catches replies a per-message delivery missed (job timeout, app restart).
export const WHATSAPP_DELIVERY_SWEEP_CRON = "* * * * *";

export type DeliverWhatsappReplyInput = {
  channelId: string;
  sessionId: string;
  // The agent user message whose reply we deliver (assistant message keyed by responseToMessageId).
  userMessageId: string;
  // The recipient's WhatsApp address (wa_id).
  to: string;
  workspaceId: string;
};

export function dispatchDeliverWhatsappReply(input: DeliverWhatsappReplyInput) {
  return inngest.send({ name: WHATSAPP_DELIVER_REPLY_EVENT, data: input });
}
