import { createHmac, timingSafeEqual } from "node:crypto";

// Linear signs the raw request body with the app's webhook signing secret and
// sends the hex digest in the `linear-signature` header; the payload's
// webhookTimestamp (epoch ms) guards against replays of captured requests.
// Kept free of db/auth imports so the webhook route and its tests stay light.
export function verifyLinearWebhookSignature(input: {
  rawBody: string;
  signature: string | null;
  webhookTimestampMs: number | null;
  nowMs?: number;
}): boolean {
  const secret = process.env.OPENCOMPANY_LINEAR_WEBHOOK_SECRET?.trim();
  if (!secret || !input.signature) return false;
  if (typeof input.webhookTimestampMs !== "number" || !Number.isFinite(input.webhookTimestampMs)) {
    return false;
  }
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - input.webhookTimestampMs) > 60_000) return false;
  const expected = createHmac("sha256", secret).update(input.rawBody).digest("hex");
  const left = Buffer.from(input.signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
