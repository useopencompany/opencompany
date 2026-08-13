import { createHmac, timingSafeEqual } from "node:crypto";

// GitHub signs the raw delivery body with the App webhook secret and sends it
// as `x-hub-signature-256: sha256=<hex hmac>`. Kept free of db/auth imports so
// the webhook route and its tests stay light.
export function verifyGoatGitHubWebhookSignature(input: {
  rawBody: string;
  signature: string | null;
}): boolean {
  const secret = process.env.GITHUB_INTEGRATION_APP_WEBHOOK_SECRET?.trim();
  if (!secret || !input.signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(input.rawBody).digest("hex")}`;
  const left = Buffer.from(input.signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
