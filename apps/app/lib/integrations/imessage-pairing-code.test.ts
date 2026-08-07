import { describe, expect, it } from "vitest";
import {
  hashImessagePairingCode,
  verifyImessagePairingCode,
} from "@/lib/integrations/imessage-pairing-code";

const secret = "test-secret-with-enough-entropy-for-hmac";

describe("iMessage pairing code hashing", () => {
  it("verifies the matching code for the same user and phone", () => {
    const hash = hashImessagePairingCode({
      code: "123456",
      userWorkosId: "user_123",
      phoneE164: "+14155551234",
      secret,
    });

    expect(hash).toMatch(/^hmac-sha256:v1:/);
    expect(
      verifyImessagePairingCode({
        code: "123456",
        userWorkosId: "user_123",
        phoneE164: "+14155551234",
        expectedHash: hash,
        secret,
      }),
    ).toBe(true);
  });

  it("binds the code to the user and phone number", () => {
    const hash = hashImessagePairingCode({
      code: "123456",
      userWorkosId: "user_123",
      phoneE164: "+14155551234",
      secret,
    });

    expect(
      verifyImessagePairingCode({
        code: "123456",
        userWorkosId: "user_other",
        phoneE164: "+14155551234",
        expectedHash: hash,
        secret,
      }),
    ).toBe(false);
    expect(
      verifyImessagePairingCode({
        code: "123456",
        userWorkosId: "user_123",
        phoneE164: "+14155559876",
        expectedHash: hash,
        secret,
      }),
    ).toBe(false);
  });

  it("rejects malformed or stale hashes", () => {
    expect(
      verifyImessagePairingCode({
        code: "123456",
        userWorkosId: "user_123",
        phoneE164: "+14155551234",
        expectedHash: "sha256:old",
        secret,
      }),
    ).toBe(false);
  });
});
