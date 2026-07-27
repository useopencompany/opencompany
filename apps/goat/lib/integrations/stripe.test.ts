import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const persistenceMocks = vi.hoisted(() => ({
  db: {
    insert: vi.fn(),
    delete: vi.fn(),
  },
  insertedValues: undefined as unknown,
  conflictSet: undefined as unknown,
  deleteWhere: vi.fn(),
  loadCredential: vi.fn(),
  markStatus: vi.fn(),
  refreshCredential: vi.fn(),
  saveCredential: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => persistenceMocks.db,
}));

vi.mock("@opencompany/db/goat-integrations", () => ({
  loadGoatIntegrationCredential: persistenceMocks.loadCredential,
  markGoatIntegrationStatus: persistenceMocks.markStatus,
  refreshGoatIntegrationCredential: persistenceMocks.refreshCredential,
  saveGoatIntegrationCredential: persistenceMocks.saveCredential,
}));

import {
  buildGoatStripeOAuthAuthorizationUrl,
  connectGoatStripeIntegration,
  createGoatStripeOAuthState,
  exchangeGoatStripeOAuthCode,
  GOAT_STRIPE_API_VERSION,
  isGoatStripeOAuthConfigured,
  refreshGoatStripeConnectionAccessToken,
  refreshGoatStripeOAuthTokens,
  validateGoatStripeOAuthAccess,
  verifyGoatStripeOAuthState,
} from "@/lib/integrations/stripe";

beforeEach(() => {
  persistenceMocks.insertedValues = undefined;
  persistenceMocks.conflictSet = undefined;
  persistenceMocks.db.insert.mockReset();
  persistenceMocks.db.insert.mockImplementation(() => ({
    values: (values: unknown) => {
      persistenceMocks.insertedValues = values;
      return {
        onConflictDoUpdate: (config: { set: unknown }) => {
          persistenceMocks.conflictSet = config.set;
          return {
            returning: async () => [{ id: "gint_stripe", userWorkosId: "user_original" }],
          };
        },
      };
    },
  }));
  persistenceMocks.deleteWhere.mockReset();
  persistenceMocks.deleteWhere.mockResolvedValue(undefined);
  persistenceMocks.db.delete.mockReset();
  persistenceMocks.db.delete.mockImplementation(() => ({
    where: persistenceMocks.deleteWhere,
  }));
  persistenceMocks.loadCredential.mockReset();
  persistenceMocks.markStatus.mockReset();
  persistenceMocks.refreshCredential.mockReset();
  persistenceMocks.saveCredential.mockReset();
  persistenceMocks.saveCredential.mockResolvedValue(undefined);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
  vi.stubEnv("GOAT_STRIPE_OAUTH_CLIENT_ID", "ca_opencompany");
  vi.stubEnv("GOAT_STRIPE_OAUTH_SECRET_KEY", "sk_test_opencompany");
  vi.stubEnv("GOAT_STRIPE_OAUTH_STATE_SECRET", "s".repeat(40));
  vi.stubEnv("GOAT_STRIPE_APP_WEBHOOK_SECRET", "whsec_opencompany");
  vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 1).toString("base64"));
  vi.stubEnv("GOAT_NEXT_PUBLIC_APP_URL", "https://goat.example.com");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Stripe Apps OAuth", () => {
  it("requires complete OAuth configuration, a strong state secret, and an exact callback", () => {
    expect(isGoatStripeOAuthConfigured()).toBe(true);

    vi.stubEnv("GOAT_STRIPE_OAUTH_STATE_SECRET", "too-short");
    expect(isGoatStripeOAuthConfigured()).toBe(false);
    expect(() =>
      createGoatStripeOAuthState({
        userWorkosId: "user_1",
        workspaceId: "workspace_1",
        returnTo: "/settings/integrations",
      }),
    ).toThrow("must be at least 32 characters");

    vi.stubEnv("GOAT_STRIPE_OAUTH_STATE_SECRET", "s".repeat(40));
    vi.stubEnv("GOAT_STRIPE_OAUTH_CALLBACK_URL", "https://goat.example.com/wrong-path");
    expect(isGoatStripeOAuthConfigured()).toBe(false);
  });

  it("signs state bound to the user, workspace, return path, and callback", () => {
    const state = createGoatStripeOAuthState({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      returnTo: "//attacker.example",
      redirectUri: "https://goat.example.com/api/integrations/stripe/callback",
    });

    expect(verifyGoatStripeOAuthState(state)).toMatchObject({
      userWorkosId: "user_1",
      workspaceId: "workspace_1",
      returnTo: "/settings/integrations",
      redirectUri: "https://goat.example.com/api/integrations/stripe/callback",
      expiresAt: Date.now() + 10 * 60 * 1_000,
    });
    expect(() => verifyGoatStripeOAuthState(`${state}tampered`)).toThrow(
      "Invalid Stripe OAuth state",
    );
  });

  it("builds the Stripe Marketplace OAuth URL with the exact callback and state", () => {
    const url = new URL(
      buildGoatStripeOAuthAuthorizationUrl(
        "signed-state",
        "https://goat.example.com/api/integrations/stripe/callback",
      ),
    );

    expect(url.origin + url.pathname).toBe("https://marketplace.stripe.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("ca_opencompany");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://goat.example.com/api/integrations/stripe/callback",
    );
    expect(url.searchParams.get("state")).toBe("signed-state");
  });

  it("exchanges the one-time code using the app developer secret", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        access_token: "oauth_access_token_123",
        refresh_token: "oauth_refresh_token_123",
        stripe_user_id: "acct_123",
        livemode: true,
        scope: "stripe_apps",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeGoatStripeOAuthCode("ac_123")).resolves.toEqual({
      accessToken: "oauth_access_token_123",
      refreshToken: "oauth_refresh_token_123",
      accountId: "acct_123",
      livemode: true,
      scope: "stripe_apps",
      expiresAt: new Date("2026-07-27T13:00:00Z"),
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string | URL | Request, RequestInit];
    expect(String(url)).toBe("https://api.stripe.com/v1/oauth/token");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("sk_test_opencompany:").toString("base64")}`,
    );
    expect(String(init.body)).toContain("grant_type=authorization_code");
    expect(String(init.body)).toContain("code=ac_123");
  });

  it("exchanges a rotating refresh token and accepts Stripe's replacement values", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        access_token: "oauth_access_token_456",
        refresh_token: "oauth_refresh_token_456",
        account_id: "acct_123",
        livemode: false,
        scope: "stripe_apps",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshGoatStripeOAuthTokens("oauth_refresh_token_123")).resolves.toEqual({
      accessToken: "oauth_access_token_456",
      refreshToken: "oauth_refresh_token_456",
      accountId: "acct_123",
      livemode: false,
      scope: "stripe_apps",
      expiresAt: new Date("2026-07-27T13:00:00Z"),
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string | URL | Request, RequestInit];
    expect(String(init.body)).toContain("grant_type=refresh_token");
    expect(String(init.body)).toContain("refresh_token=oauth_refresh_token_123");
  });

  it("sends only OAuth tokens to the encrypted credential store and removes a legacy key", async () => {
    const expiresAt = new Date("2026-07-27T13:00:00Z");
    await connectGoatStripeIntegration({
      userWorkosId: "user_reauthorizing",
      workspaceId: "workspace_1",
      tokens: {
        accessToken: "oauth_access_token_123",
        refreshToken: "oauth_refresh_token_123",
        accountId: "acct_123",
        livemode: true,
        scope: "stripe_apps",
        expiresAt,
      },
      identity: {
        accountId: "acct_123",
        accountName: "Acme Inc",
        accountEmail: "finance@example.com",
        country: "US",
        livemode: true,
      },
      now: new Date("2026-07-27T12:00:00Z"),
    });

    expect(persistenceMocks.insertedValues).toEqual(
      expect.objectContaining({
        workspaceId: "workspace_1",
        provider: "stripe",
        accountType: "stripe_oauth_live",
      }),
    );
    expect(persistenceMocks.conflictSet).toEqual(
      expect.objectContaining({
        accountType: "stripe_oauth_live",
        scopes: [
          "connected_account_read",
          "balance_read",
          "subscription_read",
          "invoice_read",
          "event_read",
        ],
      }),
    );
    expect(persistenceMocks.saveCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_original",
        integrationId: "gint_stripe",
        provider: "stripe",
        kind: "oauth_token",
        payload: {
          accessToken: "oauth_access_token_123",
          refreshToken: "oauth_refresh_token_123",
          accountId: "acct_123",
          livemode: true,
          connectedAt: "2026-07-27T12:00:00.000Z",
        },
        expiresAt,
      }),
    );
    expect(persistenceMocks.db.delete).toHaveBeenCalledOnce();
    expect(persistenceMocks.deleteWhere).toHaveBeenCalledOnce();
  });

  it("encrypts and stores Stripe's rotated refresh token before returning fresh access", async () => {
    const expiredCredential = {
      payload: {
        accessToken: "oauth_access_token_old",
        refreshToken: "oauth_refresh_token_old",
        accountId: "acct_123",
        livemode: false,
        connectedAt: "2026-07-01T00:00:00.000Z",
      },
      expiresAt: new Date("2026-07-27T11:00:00Z"),
      lastRotatedAt: null,
      updatedAt: new Date("2026-07-27T11:00:00Z"),
      encryptionKeyVersion: 1,
    };
    persistenceMocks.loadCredential.mockResolvedValue(expiredCredential);
    persistenceMocks.refreshCredential.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          access_token: "oauth_access_token_new",
          refresh_token: "oauth_refresh_token_new",
          account_id: "acct_123",
          livemode: false,
          scope: "stripe_apps",
        }),
      ),
    );

    await expect(
      refreshGoatStripeConnectionAccessToken({
        integrationId: "gint_stripe",
        userWorkosId: "user_original",
        accountId: "acct_123",
        accountName: "Acme Inc",
        livemode: false,
        accessToken: "oauth_access_token_old",
      }),
    ).resolves.toBe("oauth_access_token_new");

    expect(persistenceMocks.refreshCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        userWorkosId: "user_original",
        integrationId: "gint_stripe",
        provider: "stripe",
        kind: "oauth_token",
        payload: {
          accessToken: "oauth_access_token_new",
          refreshToken: "oauth_refresh_token_new",
          accountId: "acct_123",
          livemode: false,
          connectedAt: "2026-07-01T00:00:00.000Z",
        },
        expiresAt: new Date("2026-07-27T13:00:00Z"),
      }),
    );
  });

  it("waits for another server instance to persist a rotated Stripe token", async () => {
    const expiredCredential = {
      payload: {
        accessToken: "oauth_access_token_old",
        refreshToken: "oauth_refresh_token_old",
        accountId: "acct_123",
        livemode: false,
        connectedAt: "2026-07-01T00:00:00.000Z",
      },
      expiresAt: new Date("2026-07-27T11:00:00Z"),
      lastRotatedAt: null,
      updatedAt: new Date("2026-07-27T11:00:00Z"),
      encryptionKeyVersion: 1,
    };
    const recoveredCredential = {
      ...expiredCredential,
      payload: {
        ...expiredCredential.payload,
        accessToken: "oauth_access_token_recovered",
        refreshToken: "oauth_refresh_token_recovered",
      },
      expiresAt: new Date("2026-07-27T13:00:00Z"),
      updatedAt: new Date("2026-07-27T12:00:01Z"),
    };
    persistenceMocks.loadCredential
      .mockResolvedValueOnce(expiredCredential)
      .mockResolvedValueOnce(expiredCredential)
      .mockResolvedValueOnce(expiredCredential)
      .mockResolvedValueOnce(recoveredCredential);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400)),
    );

    const refresh = refreshGoatStripeConnectionAccessToken({
      integrationId: "gint_stripe",
      userWorkosId: "user_original",
      accountId: "acct_123",
      accountName: "Acme Inc",
      livemode: false,
      accessToken: "oauth_access_token_old",
    });
    await vi.runAllTimersAsync();

    await expect(refresh).resolves.toBe("oauth_access_token_recovered");
    expect(persistenceMocks.markStatus).not.toHaveBeenCalled();
    expect(persistenceMocks.refreshCredential).not.toHaveBeenCalled();
  });

  it("validates the OAuth account and every read endpoint before connecting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "acct_123",
          email: "finance@example.com",
          business_profile: { name: "Acme Inc" },
          country: "US",
        }),
      )
      .mockImplementation(async () => jsonResponse({ data: [], has_more: false }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateGoatStripeOAuthAccess({
        accessToken: "oauth_access_token_123",
        accountId: "acct_123",
        livemode: true,
      }),
    ).resolves.toEqual({
      ok: true,
      identity: {
        accountId: "acct_123",
        accountName: "Acme Inc",
        accountEmail: "finance@example.com",
        country: "US",
        livemode: true,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/v1/account",
      "/v1/balance",
      "/v1/balance_transactions",
      "/v1/subscriptions",
      "/v1/invoices",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer oauth_access_token_123");
      expect(new Headers(init?.headers).get("Stripe-Version")).toBe(GOAT_STRIPE_API_VERSION);
    }
  });

  it("reports a missing read-only app permission", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "acct_123" }))
      .mockResolvedValueOnce(jsonResponse({ available: [], pending: [] }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { type: "invalid_request_error", message: "Permission denied" } },
          403,
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateGoatStripeOAuthAccess({
        accessToken: "oauth_access_token_123",
        accountId: "acct_123",
        livemode: false,
      }),
    ).resolves.toEqual({
      ok: false,
      error:
        "The Stripe app was not granted read access to balance transactions. Reinstall it and accept the requested permissions.",
      reason: "missing_permissions",
    });
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
