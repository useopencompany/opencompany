import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMicrosoftAuthorizationUrl,
  createMicrosoftIntegrationState,
  exchangeMicrosoftCode,
  fetchMicrosoftUserInfo,
  sanitizeMicrosoftReturnTo,
  verifyMicrosoftIntegrationState,
} from "./microsoft-oauth";
import { microsoftScopesSatisfied } from "./microsoft-scopes";

beforeEach(() => {
  vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://app.example.com");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "test-client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("MICROSOFT_INTEGRATION_STATE_SECRET", "test-state-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const makeState = () =>
  createMicrosoftIntegrationState({
    provider: "outlook",
    userWorkosId: "user_1",
    returnTo: "/settings/plugins/outlook",
  });

describe("Microsoft OAuth", () => {
  it("uses common for both account types and separates mail/calendar consent without send", () => {
    const state = makeState();
    for (const provider of ["outlook", "outlook-calendar"] as const) {
      const url = new URL(buildMicrosoftAuthorizationUrl(provider, state));
      expect(url.pathname).toBe("/common/oauth2/v2.0/authorize");
      expect(url.searchParams.get("scope")).toBe(
        `offline_access User.Read ${provider === "outlook" ? "Mail.ReadWrite" : "Calendars.ReadWrite"}`,
      );
      expect(url.searchParams.get("redirect_uri")).toBe(
        `https://app.example.com/api/integrations/${provider}/callback`,
      );
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    }
  });
  it("verifies signed state and rejects tampering, extra segments, and expiry", () => {
    vi.useFakeTimers();
    const state = makeState();
    expect(verifyMicrosoftIntegrationState(state)).toMatchObject({
      provider: "outlook",
      userWorkosId: "user_1",
    });
    expect(() => verifyMicrosoftIntegrationState(`x${state}`)).toThrow();
    expect(() => verifyMicrosoftIntegrationState(`${state}.extra`)).toThrow();
    vi.advanceTimersByTime(600001);
    expect(() => verifyMicrosoftIntegrationState(state)).toThrow("expired");
  });
  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "/\nevil.example"])(
    "rejects unsafe return path %s",
    (path) => {
      expect(sanitizeMicrosoftReturnTo(path)).toBe("/settings");
    },
  );
  it("redeems a code using the matching server-only PKCE verifier and validates granted scopes", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "User.Read Mail.ReadWrite",
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const state = makeState();
    const url = new URL(buildMicrosoftAuthorizationUrl("outlook", state));
    const result = await exchangeMicrosoftCode("outlook", "code", state);
    const body = fetch.mock.calls[0]![1].body as URLSearchParams;
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(state).not.toContain(body.get("code_verifier")!);
    expect(result.tokens).not.toHaveProperty("expires_in");
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    fetch.mockResolvedValueOnce(
      Response.json({
        access_token: "secret-value",
        refresh_token: "refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "User.Read",
      }),
    );
    await expect(exchangeMicrosoftCode("outlook", "code", state)).rejects.toThrow(
      "required offline access",
    );
  });
  it("does not expose token response bodies or invalid credential values in errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ access_token: "do-not-echo", error: "sensitive" }, { status: 400 }),
        ),
    );
    await expect(exchangeMicrosoftCode("outlook", "code", makeState())).rejects.toThrow(
      "failed with 400.",
    );
  });
  it("accepts personal accounts with a null mail field and validates the stable id", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ id: "personal-id", mail: null, userPrincipalName: "person@outlook.com" }),
        ),
    );
    expect(await fetchMicrosoftUserInfo("access")).toMatchObject({
      id: "personal-id",
      userPrincipalName: "person@outlook.com",
    });
  });
  it("normalizes Graph resource-qualified scopes and does not require offline_access in returned grants", () => {
    expect(
      microsoftScopesSatisfied("outlook", [
        "https://graph.microsoft.com/Mail.ReadWrite",
        "user.read",
      ]),
    ).toBe(true);
    expect(microsoftScopesSatisfied("outlook-calendar", ["User.Read", "Mail.ReadWrite"])).toBe(
      false,
    );
  });
});
