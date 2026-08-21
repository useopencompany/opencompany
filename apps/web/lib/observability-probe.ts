import "server-only";

import { timingSafeEqual } from "node:crypto";

export function isObservabilityProbeAuthorized(
  authorization: string | null,
  secret: string | undefined,
) {
  const expectedSecret = secret?.trim();
  if (!authorization || !expectedSecret) return false;

  const actual = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${expectedSecret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
