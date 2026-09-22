import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGitHubWebhookSignature(input: {
  rawBody: string;
  signature: string | null;
  secret?: string | null;
}) {
  const secret =
    input.secret === undefined
      ? process.env.GITHUB_USER_APP_WEBHOOK_SECRET?.trim()
      : input.secret?.trim();
  if (!secret || !input.signature?.startsWith("sha256=")) return false;

  const presented = Buffer.from(input.signature, "utf8");
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(input.rawBody, "utf8").digest("hex")}`,
    "utf8",
  );
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
