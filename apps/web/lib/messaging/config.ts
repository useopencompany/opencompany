import {
  createWhatsAppProvider,
  type MessagingProvider,
  type WhatsAppConfig,
} from "@opencompany/messaging";

// Resolve WhatsApp Cloud API config from platform env. All secrets are platform-level (one shared
// Business number for every user) — there are no per-user WhatsApp credentials. Returns null when
// any piece is missing so the webhook and Channels tab degrade gracefully (dormant) before Meta is
// provisioned.
export function resolveWhatsAppConfig(): WhatsAppConfig | null {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_BUSINESS_ACCESS_TOKEN;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  const displayNumber = process.env.WHATSAPP_DISPLAY_NUMBER;
  if (!phoneNumberId || !accessToken || !appSecret || !verifyToken || !displayNumber) {
    return null;
  }
  return {
    phoneNumberId,
    accessToken,
    appSecret,
    verifyToken,
    displayNumber: normalizeDisplayNumber(displayNumber),
    ...(process.env.WHATSAPP_GRAPH_API_VERSION
      ? { graphApiVersion: process.env.WHATSAPP_GRAPH_API_VERSION }
      : {}),
  };
}

// The bound WhatsApp provider, or null when unconfigured. Callers MUST handle null.
export function getWhatsAppProvider(): MessagingProvider | null {
  const config = resolveWhatsAppConfig();
  return config ? createWhatsAppProvider(config) : null;
}

export function isWhatsAppConfigured(): boolean {
  return resolveWhatsAppConfig() !== null;
}

// Strip a leading `+` and any separators so the wa.me deep link is well-formed digits-only.
function normalizeDisplayNumber(value: string): string {
  return value.replace(/[^\d]/g, "");
}
