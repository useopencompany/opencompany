import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleAuthorizationUrl,
  createGoogleIntegrationState,
  exchangeGoogleCode,
  GOOGLE_PROVIDER_CONFIG,
  googleOAuthTargetOriginForState,
  verifyGoogleIntegrationState,
} from "@/lib/integrations/google-oauth";

const gmailConfig = GOOGLE_PROVIDER_CONFIG.gmail;
const driveConfig = GOOGLE_PROVIDER_CONFIG.google_drive;

describe("Google OAuth helpers", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GOOGLE_INTEGRATION_STATE_SECRET", "state-secret-with-enough-length");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.opencompany.cloud");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses the direct integration callback when broker callback is unset", () => {
    const url = new URL(buildGoogleAuthorizationUrl(gmailConfig, "signed-state"));

    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.opencompany.cloud/api/integrations/gmail/callback",
    );
  });

  it("uses the broker callback when configured", () => {
    vi.stubEnv("GOOGLE_OAUTH_CALLBACK_URL", "https://oauth.opencompany.cloud/api/google/callback");

    const url = new URL(buildGoogleAuthorizationUrl(gmailConfig, "signed-state"));

    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://oauth.opencompany.cloud/api/google/callback",
    );
  });

  it("uses the production-safe per-file Drive scope", () => {
    const url = new URL(buildGoogleAuthorizationUrl(driveConfig, "signed-state"));
    const scopes = url.searchParams.get("scope")?.split(" ") ?? [];

    expect(scopes).toContain("https://www.googleapis.com/auth/drive.file");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/drive");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.opencompany.cloud/api/integrations/google-drive/callback",
    );
  });

  it("exchanges tokens with the same broker redirect URI", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CALLBACK_URL", "https://oauth.opencompany.cloud/api/google/callback");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access-token", expires_in: 60 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await exchangeGoogleCode(gmailConfig, "auth-code");

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = init?.body as URLSearchParams;
    expect(body.get("redirect_uri")).toBe("https://oauth.opencompany.cloud/api/google/callback");
  });

  it("exchanges tokens with the signed redirect URI even if env changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access-token", expires_in: 60 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GOOGLE_OAUTH_CALLBACK_URL", "");

    await exchangeGoogleCode(
      gmailConfig,
      "auth-code",
      "https://oauth.opencompany.cloud/api/google/callback",
    );

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = init?.body as URLSearchParams;
    expect(body.get("redirect_uri")).toBe("https://oauth.opencompany.cloud/api/google/callback");
  });

  it("preserves a sanitized target origin in signed state", () => {
    const state = createGoogleIntegrationState({
      provider: "gmail",
      workspaceId: "wks_123",
      userId: "usr_123",
      returnTo: "/settings/integrations",
      oauthRedirectUri: "https://oauth.opencompany.cloud/api/google/callback",
      targetOrigin: "https://pr-42.preview.opencompany.cloud/settings?tab=integrations",
    });

    expect(verifyGoogleIntegrationState(state)).toMatchObject({
      provider: "gmail",
      oauthRedirectUri: "https://oauth.opencompany.cloud/api/google/callback",
      targetOrigin: "https://pr-42.preview.opencompany.cloud",
    });
  });

  it("drops invalid target origins from signed state", () => {
    const state = createGoogleIntegrationState({
      provider: "gmail",
      workspaceId: "wks_123",
      userId: "usr_123",
      returnTo: "/settings/integrations",
      targetOrigin: "not a url",
    });

    expect(verifyGoogleIntegrationState(state).targetOrigin).toBeUndefined();
  });

  it("adds a preview target origin only for brokered preview deployments", () => {
    vi.stubEnv("GOOGLE_OAUTH_CALLBACK_URL", "https://oauth.opencompany.cloud/api/google/callback");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pr-123.preview.opencompany.cloud");
    expect(googleOAuthTargetOriginForState()).toBe("https://pr-123.preview.opencompany.cloud");

    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.opencompany.cloud");
    expect(googleOAuthTargetOriginForState()).toBeUndefined();
  });
});
