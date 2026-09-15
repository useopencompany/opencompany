import { createHmac, timingSafeEqual } from "node:crypto";

// Convex signs a webhook log stream delivery with HMAC-SHA256 over the exact request body and
// sends the lowercase hex digest in `x-webhook-signature`, prefixed with `sha256=`. The
// per-connection endpoint in the URL has already selected which stored secret to verify against,
// so this is the whole credential check. Kept free of db/auth imports so the webhook route and its
// tests stay light.
export const CONVEX_WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature";

export function verifyConvexWebhookSignature(input: {
  body: string;
  signature: string | null | undefined;
  secret: string | null | undefined;
}): boolean {
  if (!input.signature || !input.secret) return false;
  const presented = input.signature.trim().replace(/^sha256=/u, "");
  if (!/^[0-9a-f]{64}$/u.test(presented)) return false;
  const expected = createHmac("sha256", input.secret).update(input.body, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(presented, "hex"), Buffer.from(expected, "hex"));
}
