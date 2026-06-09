import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  InboundTextMessage,
  MessagingProvider,
  SendTextInput,
  SendTextResult,
  WebhookChallengeResult,
} from "../types";

// Resolved WhatsApp Cloud API credentials + identity. The web tier builds this from env and injects
// it; this package never reads `process.env`. All fields are required to construct a live provider —
// callers that only have partial config should not call `createWhatsAppProvider`.
export type WhatsAppConfig = {
  // The Cloud API phone-number id we send from (NOT the display number) — Graph API path segment.
  phoneNumberId: string;
  // A permanent system-user access token with whatsapp_business_messaging.
  accessToken: string;
  // The Meta app secret, used to verify inbound webhook signatures (X-Hub-Signature-256).
  appSecret: string;
  // The string we configured as the webhook Verify Token in the Meta dashboard.
  verifyToken: string;
  // Our public WhatsApp number in E.164 digits WITHOUT the leading `+` (e.g. "15551234567"),
  // used to build the `wa.me` deep link the user taps to start a chat.
  displayNumber: string;
  // Graph API version segment. Defaults to a recent stable version.
  graphApiVersion?: string;
};

const DEFAULT_GRAPH_API_VERSION = "v21.0";

// Construct a WhatsApp provider bound to `config`. The returned object implements the generic
// `MessagingProvider` contract so the rest of the system stays provider-agnostic.
export function createWhatsAppProvider(config: WhatsAppConfig): MessagingProvider {
  const graphVersion = config.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;

  return {
    id: "whatsapp",

    verifyChallenge(params: URLSearchParams): WebhookChallengeResult {
      // Meta's subscription handshake: GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
      const mode = params.get("hub.mode");
      const token = params.get("hub.verify_token");
      const challenge = params.get("hub.challenge");
      if (mode !== "subscribe") return { ok: false, reason: "unexpected hub.mode" };
      if (!token || token !== config.verifyToken) {
        return { ok: false, reason: "verify token mismatch" };
      }
      if (!challenge) return { ok: false, reason: "missing hub.challenge" };
      return { ok: true, challenge };
    },

    verifySignature(rawBody: string, signatureHeader: string | null): boolean {
      // Meta signs the raw request body as `sha256=<hex>` in X-Hub-Signature-256.
      if (!signatureHeader) return false;
      const expectedHex = signatureHeader.startsWith("sha256=")
        ? signatureHeader.slice("sha256=".length)
        : signatureHeader;
      const computedHex = createHmac("sha256", config.appSecret)
        .update(rawBody, "utf8")
        .digest("hex");
      // Constant-time compare; bail before timingSafeEqual if lengths differ (it throws otherwise).
      if (expectedHex.length !== computedHex.length) return false;
      try {
        return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(computedHex, "hex"));
      } catch {
        return false;
      }
    },

    parseInbound(body: unknown): InboundTextMessage[] {
      return parseWhatsAppInbound(body);
    },

    async sendText(input: SendTextInput): Promise<SendTextResult> {
      const url = `https://graph.facebook.com/${graphVersion}/${config.phoneNumberId}/messages`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: input.to,
          type: "text",
          // Disable link previews to keep agent replies compact and predictable.
          text: { preview_url: false, body: input.text },
        }),
      });

      if (!response.ok) {
        const detail = await safeReadText(response);
        throw new Error(`WhatsApp send failed (${response.status}): ${detail}`);
      }

      const payload = (await response.json()) as {
        messages?: Array<{ id?: string }>;
      };
      const providerMessageId = payload.messages?.[0]?.id;
      if (!providerMessageId) {
        throw new Error("WhatsApp send returned no message id");
      }
      return { providerMessageId };
    },

    buildLinkDeeplink(input: { token: string }): string {
      const text = encodeURIComponent(`link ${input.token}`);
      return `https://wa.me/${config.displayNumber}?text=${text}`;
    },
  };
}

// Pure parser exported separately so it can be unit-tested without a provider/config. WhatsApp
// nests inbound messages under entry[].changes[].value.messages[]; we surface only text messages.
export function parseWhatsAppInbound(body: unknown): InboundTextMessage[] {
  const messages: InboundTextMessage[] = [];
  if (!isRecord(body)) return messages;

  const entries = asArray(body.entry);
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    for (const change of asArray(entry.changes)) {
      if (!isRecord(change)) continue;
      const value = isRecord(change.value) ? change.value : null;
      if (!value) continue;

      // contacts[].wa_id ↔ contacts[].profile.name lets us attach a display name to the sender.
      const profileByWaId = new Map<string, string>();
      for (const contact of asArray(value.contacts)) {
        if (!isRecord(contact)) continue;
        const waId = typeof contact.wa_id === "string" ? contact.wa_id : null;
        const profile = isRecord(contact.profile) ? contact.profile : null;
        const name = profile && typeof profile.name === "string" ? profile.name : null;
        if (waId && name) profileByWaId.set(waId, name);
      }

      for (const message of asArray(value.messages)) {
        if (!isRecord(message)) continue;
        if (message.type !== "text") continue;
        const id = typeof message.id === "string" ? message.id : null;
        const from = typeof message.from === "string" ? message.from : null;
        const textRecord = isRecord(message.text) ? message.text : null;
        const text = textRecord && typeof textRecord.body === "string" ? textRecord.body : null;
        if (!id || !from || text === null) continue;

        const timestampSeconds = parseTimestampSeconds(message.timestamp);
        const profileName = profileByWaId.get(from);
        messages.push({
          providerMessageId: id,
          from,
          text,
          timestampSeconds,
          ...(profileName ? { profileName } : {}),
        });
      }
    }
  }

  return messages;
}

function parseTimestampSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
