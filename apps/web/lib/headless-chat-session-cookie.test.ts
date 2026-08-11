import { describe, expect, it } from "vitest";
import {
  hostSessionCookieDeletion,
  sharedSessionCookieHeaders,
} from "./headless-chat-session-cookie";

describe("headless Chat shared browser session", () => {
  it("migrates a host-only WorkOS cookie to the first-party parent domain", () => {
    const headers = sharedSessionCookieHeaders({
      name: "wos-session",
      value: "sealed/session",
      configuredDomain: ".opencompany.chat",
      requestHostname: "my.opencompany.chat",
      apiOrigin: "https://api.opencompany.chat",
      secure: true,
    });

    expect(headers[0]).toContain("wos-session=;");
    expect(headers[0]).toContain("Max-Age=0");
    expect(headers[0]).not.toContain("Domain=");
    expect(headers[1]).toContain("wos-session=sealed%2Fsession");
    expect(headers[1]).toContain("Domain=opencompany.chat");
    expect(headers[1]).toContain("HttpOnly");
    expect(headers[1]).toContain("Secure");
  });

  it("rejects a cookie domain that does not cover both first-party hosts", () => {
    expect(() =>
      sharedSessionCookieHeaders({
        name: "wos-session",
        value: "sealed",
        configuredDomain: "my.opencompany.chat",
        requestHostname: "my.opencompany.chat",
        apiOrigin: "https://api.opencompany.chat",
        secure: true,
      }),
    ).toThrow("must cover");
  });

  it("builds a host-only deletion for sign-out migration cleanup", () => {
    expect(hostSessionCookieDeletion("wos-session", true)).toEqual(
      expect.objectContaining({ name: "wos-session", maxAge: 0, secure: true }),
    );
  });
});
