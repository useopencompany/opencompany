import { createHmac, timingSafeEqual } from "node:crypto";

// Slack signs `v0:{timestamp}:{raw body}` with the app signing secret; the
// timestamp window guards against replays of captured requests. Kept free of
// db/auth imports so the webhook route and its tests stay light.
export function verifyGoatSlackEventSignature(input: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  nowMs?: number;
  // Defaults to the ingestion app's secret; the bot webhook passes its own.
  secret?: string | undefined;
}): boolean {
  const secret = (input.secret ?? process.env.GOAT_SLACK_SIGNING_SECRET)?.trim();
  if (!secret || !input.timestamp || !input.signature) return false;
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs / 1000 - timestampSeconds) > 300) return false;
  const expected = `v0=${createHmac("sha256", secret)
    .update(`v0:${input.timestamp}:${input.rawBody}`)
    .digest("hex")}`;
  const left = Buffer.from(input.signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
