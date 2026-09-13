import { timingSafeEqual } from "node:crypto";

// Jamie authenticates its deliveries by echoing a static key it minted when the user created the
// webhook. The per-connection endpoint in the URL has already selected which stored secret to
// compare against, so this is the whole credential check. Kept free of db/auth imports so the
// webhook route and its tests stay light.
export function verifyJamieWebhookKey(input: {
  presented: string | null | undefined;
  expected: string | null | undefined;
}): boolean {
  if (!input.presented || !input.expected) return false;
  const presented = Buffer.from(input.presented);
  const expected = Buffer.from(input.expected);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
