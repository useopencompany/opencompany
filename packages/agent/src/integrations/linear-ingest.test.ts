import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = { sentinel: "db" };
const mocks = vi.hoisted(() => ({
  claimRefresh: vi.fn(async () => true),
  loadCredential: vi.fn(),
  markStatus: vi.fn(async () => undefined),
  releaseRefresh: vi.fn(async () => undefined),
  rotateCredential: vi.fn(async () => ({ id: "gcred_linear" })),
}));

vi.mock("@opencompany/db/client", () => ({ getDb: () => db }));
vi.mock("@opencompany/db/integrations", () => ({
  claimIntegrationCredentialRefresh: mocks.claimRefresh,
  loadIntegrationCredential: mocks.loadCredential,
  markIntegrationStatus: mocks.markStatus,
  releaseIntegrationCredentialRefresh: mocks.releaseRefresh,
  rotateIntegrationCredential: mocks.rotateCredential,
}));

import {
  exchangeLinearCode,
  getLinearIngestAccessToken,
  LinearIngestAuthError,
} from "./linear-ingest";

const now = new Date("2026-09-14T12:00:00.000Z");
const connection = { userWorkosId: "user_1", integrationId: "gint_linear" };

function storedCredential(overrides: Record<string, unknown> = {}) {
  return {
    payload: {
      access_token: "linear_access_old",
      refresh_token: "linear_refresh_old",
      token_type: "bearer",
      organization_id: "linear_org_1",
      organization_name: "Acme",
      scope: "read",
      ...overrides,
    },
    expiresAt: new Date("2026-09-14T11:00:00.000Z"),
    lastRotatedAt: new Date("2026-09-13T12:00:00.000Z"),
    updatedAt: new Date("2026-09-13T12:00:00.000Z"),
    encryptionKeyVersion: 1,
  };
}

describe("Linear ingest OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("OPENCOMPANY_LINEAR_CLIENT_ID", "linear-client");
    vi.stubEnv("OPENCOMPANY_LINEAR_CLIENT_SECRET", "linear-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("requires and records Linear's expiring access and rotating refresh tokens", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "linear_access_1",
        refresh_token: "linear_refresh_1",
        token_type: "Bearer",
        expires_in: 86_399,
        scope: "read",
      }),
    );

    await expect(exchangeLinearCode("authorization-code", { now })).resolves.toEqual({
      accessToken: "linear_access_1",
      refreshToken: "linear_refresh_1",
      tokenType: "bearer",
      accessTokenExpiresAt: new Date("2026-09-15T11:59:59.000Z"),
      scopes: ["read"],
    });
    const request = fetchMock.mock.calls[0]?.[1];
    expect(String(request?.body)).toContain("grant_type=authorization_code");
  });

  it("rotates and persists both Linear tokens before the access token expires", async () => {
    mocks.loadCredential.mockResolvedValue(storedCredential());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "linear_access_new",
        refresh_token: "linear_refresh_new",
        token_type: "bearer",
        expires_in: 86_399,
        scope: "read",
      }),
    );

    await expect(getLinearIngestAccessToken(connection, { db, now })).resolves.toBe(
      "linear_access_new",
    );
    expect(mocks.rotateCredential).toHaveBeenCalledWith({
      ...connection,
      provider: "linear",
      kind: "oauth_token",
      payload: {
        access_token: "linear_access_new",
        refresh_token: "linear_refresh_new",
        token_type: "bearer",
        organization_id: "linear_org_1",
        organization_name: "Acme",
        scope: "read",
      },
      expiresAt: new Date("2026-09-15T11:59:59.000Z"),
      expectedLastRotatedAt: new Date("2026-09-13T12:00:00.000Z"),
      expectedRefreshLeaseUntil: new Date("2026-09-14T12:00:30.000Z"),
      db,
      now,
    });
  });

  it("uses a legacy token until rejection, then requires a one-time reconnect", async () => {
    mocks.loadCredential.mockResolvedValue({
      ...storedCredential({ refresh_token: undefined }),
      expiresAt: null,
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(getLinearIngestAccessToken(connection, { db, now })).resolves.toBe(
      "linear_access_old",
    );
    expect(mocks.markStatus).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      getLinearIngestAccessToken(connection, {
        db,
        now,
        refreshIfAccessToken: "linear_access_old",
      }),
    ).rejects.toBeInstanceOf(LinearIngestAuthError);
    expect(mocks.markStatus).toHaveBeenCalledWith({
      ...connection,
      provider: "linear",
      status: "needs_reauth",
      statusReason: "The Linear connection needs a one-time reconnect to enable token refresh.",
      db,
      now,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires reconnection when Linear refuses the rotating refresh token", async () => {
    mocks.loadCredential.mockResolvedValue(storedCredential());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );

    await expect(getLinearIngestAccessToken(connection, { db, now })).rejects.toBeInstanceOf(
      LinearIngestAuthError,
    );
    expect(mocks.releaseRefresh).toHaveBeenCalledOnce();
    expect(mocks.markStatus).toHaveBeenCalledWith({
      ...connection,
      provider: "linear",
      status: "needs_reauth",
      statusReason: "Linear refused the saved refresh token. Reconnect Linear.",
      db,
      now,
    });
  });
});
