import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export type WhatsappConfig = { apiKey: string; phoneNumberId: string; lineHandle: string };
export const WHATSAPP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const WHATSAPP_MAX_TEXT_LENGTH = 4096;

export function whatsappConfig(env: NodeJS.ProcessEnv = process.env): WhatsappConfig | null {
  const apiKey = env.KAPSO_API_KEY?.trim();
  const phoneNumberId = env.KAPSO_PHONE_NUMBER_ID?.trim();
  const lineHandle = env.WHATSAPP_LINE_HANDLE?.trim();
  return apiKey &&
    phoneNumberId &&
    /^\d+$/.test(phoneNumberId) &&
    lineHandle &&
    /^\+[1-9]\d{6,14}$/.test(lineHandle)
    ? { apiKey, phoneNumberId, lineHandle }
    : null;
}

// EEA registered numbers are the initial supported audience under Meta's AI-provider terms.
// An American sender number does not make American recipients eligible for this assistant.
const EEA_PREFIXES = [
  "30",
  "31",
  "32",
  "33",
  "34",
  "351",
  "352",
  "353",
  "354",
  "356",
  "357",
  "358",
  "359",
  "36",
  "370",
  "371",
  "372",
  "385",
  "386",
  "39",
  "40",
  "420",
  "421",
  "423",
  "43",
  "45",
  "46",
  "47",
  "48",
  "49",
];
export function isWhatsappBetaNumber(phone: string) {
  const digits = phone.replace(/^\+/, "");
  return (
    /^[1-9]\d{6,14}$/.test(digits) &&
    !digits.startsWith("3906698") &&
    EEA_PREFIXES.some((prefix) => digits.startsWith(prefix))
  );
}

export function verifyWhatsappSignature(rawBody: string, signature: string | null, secret: string) {
  if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

const MessageSchema = z.object({
  id: z.string().min(1).max(256),
  from: z
    .string()
    .regex(/^[1-9]\d{6,14}$/)
    .optional(),
  from_user_id: z.string().max(256).optional(),
  timestamp: z.string().regex(/^\d+$/),
  type: z.string(),
  text: z.object({ body: z.string().max(16_384) }).optional(),
});
const EnvelopeSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              field: z.string(),
              value: z.object({
                metadata: z.object({ phone_number_id: z.string() }),
                messages: z.array(MessageSchema).max(100).optional(),
              }),
            }),
          )
          .max(100),
      }),
    )
    .max(100),
});
export type WhatsappInbound = {
  messageId: string;
  sender: string;
  text: string;
  receivedAt: string;
  phoneNumberId: string;
};

// Configure a number-scoped Kapso webhook with kind=meta (raw Meta forwarding).
// Status-only events and BSUID-only identities never accidentally start an agent turn.
export function parseWhatsappMessages(payload: unknown, phoneNumberId: string): WhatsappInbound[] {
  const envelope = EnvelopeSchema.parse(payload);
  const result: WhatsappInbound[] = [];
  for (const entry of envelope.entry)
    for (const change of entry.changes) {
      if (change.field !== "messages" || change.value.metadata.phone_number_id !== phoneNumberId)
        continue;
      for (const message of change.value.messages ?? []) {
        if (!message.from) continue;
        const ms = Number(message.timestamp) * 1000;
        if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 8.64e15) continue;
        result.push({
          messageId: message.id,
          sender: `+${message.from}`,
          text: message.type === "text" ? (message.text?.body.trim() ?? "") : "",
          receivedAt: new Date(ms).toISOString(),
          phoneNumberId,
        });
      }
    }
  return result;
}

export function isWhatsappReplyWindowOpen(receivedAt: string, now = Date.now()) {
  const at = Date.parse(receivedAt);
  return Number.isFinite(at) && at <= now + 60_000 && now - at < WHATSAPP_REPLY_WINDOW_MS;
}

export function createWhatsappClient(config: WhatsappConfig, fetcher: typeof fetch = fetch) {
  return {
    async sendMessage(input: { to: string; text: string; replyTo?: string; signal?: AbortSignal }) {
      if (!isWhatsappBetaNumber(input.to))
        throw new Error("This number is outside the WhatsApp beta region.");
      if (!input.text.trim() || input.text.length > WHATSAPP_MAX_TEXT_LENGTH)
        throw new Error("WhatsApp replies must contain 1–4096 characters.");
      const response = await fetcher(
        `https://api.kapso.ai/meta/whatsapp/v24.0/${config.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: { "X-API-Key": config.apiKey, "Content-Type": "application/json" },
          signal: input.signal
            ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: input.to.replace(/^\+/, ""),
            type: "text",
            text: { body: input.text, preview_url: false },
            ...(input.replyTo ? { context: { message_id: input.replyTo } } : {}),
          }),
        },
      );
      // Provider bodies may contain private message content; never put them in logs or tool errors.
      if (!response.ok)
        throw new Error(`WhatsApp could not accept the reply (HTTP ${response.status}).`);
      const parsed = z
        .object({ messages: z.array(z.object({ id: z.string().min(1) })).min(1) })
        .parse(await response.json());
      return { id: parsed.messages[0]!.id };
    },
  };
}
export type WhatsappClient = ReturnType<typeof createWhatsappClient>;

export function readWhatsappInboundSettings(settings: Record<string, unknown> | undefined) {
  const result = z
    .object({
      messageId: z.string().min(1),
      sender: z.string().min(1),
      phoneNumberId: z.string().min(1),
      receivedAt: z.string().datetime(),
    })
    .safeParse(settings?.whatsapp);
  return result.success ? result.data : null;
}
