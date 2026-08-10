import { createHmac, timingSafeEqual } from "node:crypto";

// Attio signs the raw request body with the webhook's secret (minted at
// webhook creation, stored per integration) and sends the hex HMAC-SHA256
// digest in `Attio-Signature`. There is no timestamp header, so no replay
// window applies; the buffer's delivery-id uniqueness absorbs replays of
// stable-id events. Kept free of db/auth imports so the webhook route and its
// tests stay light.
export function verifyGoatAttioWebhookSignature(input: {
  rawBody: string;
  signature: string | null;
  secret: string | null | undefined;
}): boolean {
  if (!input.secret || !input.signature) return false;
  const signature = Buffer.from(input.signature.trim());
  const expected = Buffer.from(
    createHmac("sha256", input.secret).update(input.rawBody, "utf8").digest("hex"),
  );
  return signature.length === expected.length && timingSafeEqual(signature, expected);
}
