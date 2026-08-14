import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildXAccountAuthorizationUrl,
  createXAccountIntegrationState,
  createXAccountPkce,
  verifyXAccountIntegrationState,
  X_ACCOUNT_SCOPES,
} from "./x-account";

describe("opencompany X account OAuth", () => {
  beforeEach(() => {
    vi.stubEnv("GOAT_X_CLIENT_ID", "client-id");
    vi.stubEnv("GOAT_X_STATE_SECRET", "state-secret");
    vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips signed state for the opencompany user", () => {
    const state = createXAccountIntegrationState({
      userWorkosId: "user_123",
      returnTo: "/settings",
    });

    expect(verifyXAccountIntegrationState(state)).toMatchObject({
      userWorkosId: "user_123",
      returnTo: "/settings",
    });
  });

  it("rejects a tampered state signature", () => {
    const state = createXAccountIntegrationState({
      userWorkosId: "user_123",
      returnTo: "/settings",
    });
    const [body] = state.split(".");
    expect(() => verifyXAccountIntegrationState(`${body}.tampered`)).toThrow();
  });

  it("keeps the signed state within X's 500-character limit", () => {
    const state = createXAccountIntegrationState({
      userWorkosId: "user_01H8XG7Z3K9QRSTUVWXYZ01234",
      returnTo: "/settings/integrations",
    });
    expect(state.length).toBeLessThanOrEqual(500);
  });

  it("generates a fresh, spec-sized PKCE pair each time", () => {
    const first = createXAccountPkce();
    const second = createXAccountPkce();
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    expect(first.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(first.codeVerifier.length).toBeLessThanOrEqual(128);
    expect(first.codeChallenge).not.toBe(first.codeVerifier);
  });

  it("builds an authorization URL requesting tweet.write with PKCE", () => {
    const { codeChallenge } = createXAccountPkce();
    const url = new URL(buildXAccountAuthorizationUrl("state-value", codeChallenge));

    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://opencompany.example.com/api/integrations/x-account/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe(codeChallenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...X_ACCOUNT_SCOPES]);
  });
});
