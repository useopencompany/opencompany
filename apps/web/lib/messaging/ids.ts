// Id helpers for messaging rows. Mirrors the `ses_`/`msg_` style from @opencompany/agent-runtime.
export function newMessagingChannelId() {
  return `mch_${randomSuffix()}`;
}

export function newMessagingMessageId() {
  return `mmsg_${randomSuffix()}`;
}

// Opaque one-time link token embedded in the connect QR's wa.me deep link. Full-entropy (no slice)
// since it gates binding a phone number to a personal agent.
export function newMessagingLinkToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

function randomSuffix() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}
