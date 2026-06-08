// The messaging-channel abstraction. A "channel" is a transport that carries text between a user
// and their personal agent (WhatsApp today; Telegram/iMessage later). Everything channel-specific
// lives behind the `MessagingProvider` interface so the web tier never branches on provider — it
// resolves a provider, then calls the same four verbs: verify, parse, send, link.
//
// Design notes that keep this package pure and unit-testable:
//   - No `process.env` access in here. The web tier resolves secrets into a provider `config` and
//     injects it (see `createWhatsAppProvider`). That keeps providers deterministic in tests.
//   - `parseInbound` is signature-free and pure; signature verification is its own step so the
//     caller can reject before parsing.

export type MessagingProviderId = "whatsapp";

// A normalized inbound text message, provider-agnostic. We only model text for v1 — media/
// reactions/etc. are dropped by `parseInbound` rather than represented here.
export type InboundTextMessage = {
  // Stable, provider-issued id for this message (WhatsApp `wamid`). Used to dedupe webhook
  // retries — providers redeliver, so this is the idempotency key for inbound.
  providerMessageId: string;
  // The sender's channel address. For WhatsApp this is the `wa_id` (E.164 digits, no `+`).
  from: string;
  // The plain-text body.
  text: string;
  // Provider-reported send time, unix epoch seconds.
  timestampSeconds: number;
  // The sender's display/profile name, when the provider includes it.
  profileName?: string;
};

// Result of the GET verification handshake some providers require to enable a webhook (Meta sends
// `hub.mode`/`hub.verify_token`/`hub.challenge` and expects the challenge echoed back on success).
export type WebhookChallengeResult =
  | { ok: true; challenge: string }
  | { ok: false; reason: string };

export type SendTextInput = {
  // The recipient's channel address (WhatsApp `wa_id`).
  to: string;
  text: string;
};

export type SendTextResult = {
  providerMessageId: string;
};

// A provider binds transport-specific behavior to a resolved `config`. Construct one via the
// provider's factory (e.g. `createWhatsAppProvider(config)`); the web tier owns config resolution.
export interface MessagingProvider {
  readonly id: MessagingProviderId;

  // Answer the provider's webhook-subscription GET handshake. `params` is the request query string.
  verifyChallenge(params: URLSearchParams): WebhookChallengeResult;

  // Validate the authenticity of a webhook POST. `rawBody` MUST be the exact bytes received (not a
  // re-serialized object) so the HMAC matches. Returns false on any mismatch or missing signature.
  verifySignature(rawBody: string, signatureHeader: string | null): boolean;

  // Parse a webhook POST body into normalized inbound messages. Pure; ignores non-text events.
  parseInbound(body: unknown): InboundTextMessage[];

  // Deliver a text message to `to`. Throws on transport/HTTP failure so callers can retry.
  sendText(input: SendTextInput): Promise<SendTextResult>;

  // Build the deep link a user taps to start a chat with our number, pre-filled with the link
  // token (e.g. `https://wa.me/<number>?text=link%20<token>`). The QR in the Channels tab encodes
  // this. Returns null if the provider has no such onboarding affordance.
  buildLinkDeeplink(input: { token: string }): string | null;
}

// Lightweight catalog metadata for the Channels UI — provider identity independent of any secrets,
// so the tab can render the WhatsApp card even before the platform is configured.
export type MessagingProviderInfo = {
  id: MessagingProviderId;
  label: string;
  description: string;
};
