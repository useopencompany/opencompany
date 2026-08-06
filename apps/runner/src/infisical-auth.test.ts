import { describe, expect, it } from "vitest";
import { decodeInfisicalBrowserToken, parseInfisicalLoginUrl } from "./infisical-auth";

describe("Infisical CLI browser login", () => {
  it("accepts only the pinned Infisical Cloud callback URL", () => {
    expect(
      parseInfisicalLoginUrl(
        "To complete your login, open this address in your browser: https://app.infisical.com/login?callback_port=43123",
      ),
    ).toBe("https://app.infisical.com/login?callback_port=43123");
    expect(parseInfisicalLoginUrl("https://evil.example/login?callback_port=43123")).toBeNull();
    expect(
      parseInfisicalLoginUrl("https://app.infisical.com/login?callback_port=99999"),
    ).toBeNull();
  });

  it("decodes the credential envelope used by Infisical's paste fallback", () => {
    const token = Buffer.from(
      JSON.stringify({
        email: "founder@example.com",
        privateKey: "private-key",
        JTWToken: "signed.jwt.token",
        RefreshToken: "refresh-token",
      }),
      "utf8",
    ).toString("base64");

    expect(decodeInfisicalBrowserToken(token)).toEqual({
      email: "founder@example.com",
      privateKey: "private-key",
      jwt: "signed.jwt.token",
      refreshToken: "refresh-token",
    });
  });

  it("rejects malformed or incomplete browser tokens", () => {
    expect(() => decodeInfisicalBrowserToken("not-base64-json")).toThrow(
      "That does not look like a valid Infisical browser token.",
    );
    expect(() =>
      decodeInfisicalBrowserToken(
        Buffer.from(JSON.stringify({ email: "founder@example.com" })).toString("base64"),
      ),
    ).toThrow("That does not look like a valid Infisical browser token.");
  });
});
