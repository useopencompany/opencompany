import { describe, expect, it } from "vitest";
import { createSessionStreamToken, verifySessionStreamToken } from "./tokens";

describe("session stream tokens", () => {
  it("round-trips a signed token", () => {
    const token = createSessionStreamToken(
      { sessionId: "ses_123", userId: "usr_123", expiresAt: Date.now() + 10_000 },
      "secret",
    );

    expect(verifySessionStreamToken(token, "secret")).toMatchObject({
      sessionId: "ses_123",
      userId: "usr_123",
    });
  });

  it("rejects tokens signed with a different secret", () => {
    const token = createSessionStreamToken(
      { sessionId: "ses_123", userId: "usr_123", expiresAt: Date.now() + 10_000 },
      "secret",
    );

    expect(() => verifySessionStreamToken(token, "other")).toThrow("Invalid stream token");
  });
});
