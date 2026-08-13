import { describe, expect, it } from "vitest";
import { hashGoatImessagePairingCode, verifyGoatImessagePairingCode } from "./pairing-code";

const secret = "test-secret-with-enough-entropy-for-hmac";

describe("iMessage pairing code hashing", () => {
  it("verifies the matching code for the same user and phone", () => {
    const hash = hashGoatImessagePairingCode({
      code: "123456",
      userWorkosId: "user_123",
      phoneE164: "+14155551234",
      secret,
    });

    expect(hash).toMatch(/^hmac-sha256:v1:/);
    expect(
      verifyGoatImessagePairingCode({
        code: "123456",
        userWorkosId: "user_123",
        phoneE164: "+14155551234",
        expectedHash: hash,
        secret,
      }),
    ).toBe(true);
  });

  it("binds the code to the user and phone number", () => {
    const hash = hashGoatImessagePairingCode({
      code: "123456",
      userWorkosId: "user_123",
      phoneE164: "+14155551234",
      secret,
    });

    expect(
      verifyGoatImessagePairingCode({
        code: "123456",
        userWorkosId: "user_other",
        phoneE164: "+14155551234",
        expectedHash: hash,
        secret,
      }),
    ).toBe(false);
    expect(
      verifyGoatImessagePairingCode({
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
      verifyGoatImessagePairingCode({
        code: "123456",
        userWorkosId: "user_123",
        phoneE164: "+14155551234",
        expectedHash: "sha256:old",
        secret,
      }),
    ).toBe(false);
  });
});
