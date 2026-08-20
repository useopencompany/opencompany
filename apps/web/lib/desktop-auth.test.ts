import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DesktopHandoffError,
  deriveDesktopChallenge,
  isValidDesktopChallenge,
  mintDesktopHandoffToken,
  redeemDesktopHandoffToken,
} from "@/lib/desktop-auth";

// 32-byte base64 key, matching the INTEGRATION_CREDENTIAL_ENCRYPTION_KEY convention.
const TEST_SECRET = randomBytes(32).toString("base64");

function newVerifier() {
  return randomBytes(32).toString("base64url");
}

beforeAll(() => {
  process.env.OPENCOMPANY_DESKTOP_AUTH_SECRET = TEST_SECRET;
});

describe("deriveDesktopChallenge", () => {
  it("produces a 43-char base64url challenge accepted by the validator", () => {
    const challenge = deriveDesktopChallenge(newVerifier());
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isValidDesktopChallenge(challenge)).toBe(true);
  });

  it("rejects malformed challenges", () => {
    expect(isValidDesktopChallenge("too-short")).toBe(false);
    expect(isValidDesktopChallenge(`${"a".repeat(42)}+`)).toBe(false);
    expect(isValidDesktopChallenge(123)).toBe(false);
  });
});

describe("desktop handoff token round trip", () => {
  it("mints and redeems with the matching verifier", () => {
    const verifier = newVerifier();
    const challenge = deriveDesktopChallenge(verifier);
    const token = mintDesktopHandoffToken({ refreshToken: "refresh-abc", challenge });

    const redeemed = redeemDesktopHandoffToken(token, verifier);

    expect(redeemed).toEqual({ refreshToken: "refresh-abc", authMethod: "GoogleOAuth" });
  });

  it("rejects an expired token", () => {
    const verifier = newVerifier();
    const challenge = deriveDesktopChallenge(verifier);
    const mintedAt = 1_000_000;
    const token = mintDesktopHandoffToken({
      refreshToken: "refresh-abc",
      challenge,
      now: mintedAt,
    });

    // 61s later — past the 60s TTL.
    expect(() => redeemDesktopHandoffToken(token, verifier, { now: mintedAt + 61_000 })).toThrow(
      DesktopHandoffError,
    );
    // Still valid one second before expiry.
    expect(() =>
      redeemDesktopHandoffToken(token, verifier, { now: mintedAt + 59_000 }),
    ).not.toThrow();
  });

  it("rejects a mismatched verifier", () => {
    const challenge = deriveDesktopChallenge(newVerifier());
    const token = mintDesktopHandoffToken({ refreshToken: "refresh-abc", challenge });

    expect(() => redeemDesktopHandoffToken(token, newVerifier())).toThrow(DesktopHandoffError);
  });

  it("rejects a malformed verifier", () => {
    const verifier = newVerifier();
    const challenge = deriveDesktopChallenge(verifier);
    const token = mintDesktopHandoffToken({ refreshToken: "refresh-abc", challenge });

    expect(() => redeemDesktopHandoffToken(token, "not-a-valid-verifier")).toThrow(
      DesktopHandoffError,
    );
  });

  it("rejects a tampered token", () => {
    const verifier = newVerifier();
    const challenge = deriveDesktopChallenge(verifier);
    const token = mintDesktopHandoffToken({ refreshToken: "refresh-abc", challenge });

    // Flip the final character of the base64url payload.
    const flipped = token.slice(0, -1) + (token.at(-1) === "A" ? "B" : "A");

    expect(() => redeemDesktopHandoffToken(flipped, verifier)).toThrow(DesktopHandoffError);
  });

  it("rejects a garbage token", () => {
    expect(() => redeemDesktopHandoffToken("!!!not-base64!!!", newVerifier())).toThrow(
      DesktopHandoffError,
    );
  });
});
