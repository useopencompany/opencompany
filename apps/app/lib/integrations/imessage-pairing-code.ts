import { createHmac, timingSafeEqual } from "node:crypto";

const HASH_PREFIX = "hmac-sha256:v1:";

type PairingCodeHashInput = {
  code: string;
  userWorkosId: string;
  phoneE164: string;
  secret?: string;
};

type PairingCodeVerifyInput = PairingCodeHashInput & {
  expectedHash: string;
};

function pairingCodeSecret(inputSecret?: string): string {
  const secret = inputSecret ?? process.env.WORKOS_COOKIE_PASSWORD;
  if (!secret) {
    throw new Error("WORKOS_COOKIE_PASSWORD is required to hash iMessage pairing codes.");
  }
  return secret;
}

export function hashGoatImessagePairingCode(input: PairingCodeHashInput): string {
  const body = [input.userWorkosId, input.phoneE164, input.code].join("\0");
  return `${HASH_PREFIX}${createHmac("sha256", pairingCodeSecret(input.secret))
    .update(body, "utf8")
    .digest("base64url")}`;
}

export function verifyGoatImessagePairingCode(input: PairingCodeVerifyInput): boolean {
  const actual = Buffer.from(hashGoatImessagePairingCode(input), "utf8");
  const expected = Buffer.from(input.expectedHash, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
