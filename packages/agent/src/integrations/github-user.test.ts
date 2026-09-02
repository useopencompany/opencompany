import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = { sentinel: "db" };
const mocks = vi.hoisted(() => ({
  claimRefresh: vi.fn(async () => true),
  loadCredential: vi.fn(),
  markStatus: vi.fn(async () => undefined),
  releaseRefresh: vi.fn(async () => undefined),
  rotateCredential: vi.fn(async () => ({ id: "gcred_github_user" })),
}));

vi.mock("@opencompany/db/client", () => ({ getDb: () => db }));
vi.mock("@opencompany/db/integrations", () => ({
  GITHUB_USER_INTEGRATION_EXTERNAL_ID: "github_user",
  claimIntegrationCredentialRefresh: mocks.claimRefresh,
  loadIntegrationCredential: mocks.loadCredential,
  markIntegrationStatus: mocks.markStatus,
  releaseIntegrationCredentialRefresh: mocks.releaseRefresh,
  rotateIntegrationCredential: mocks.rotateCredential,
}));

import {
  buildGitHubUserInstallUrl,
  createGitHubUserIntegrationState,
  exchangeGitHubAppUserCode,
  fetchGitHubUserIdentity,
  GitHubUserAccessAuthError,
  getGitHubUserAccessToken,
  isGitHubUserIntegrationConfigured,
  loadGitHubUserCredentialIdentity,
  verifyGitHubUserIntegrationState,
} from "./github-user";

const now = new Date("2026-09-01T12:00:00.000Z");
const connection = { userWorkosId: "user_1", integrationId: "gint_github_user" };

function storedCredential(overrides: Record<string, unknown> = {}) {
  return {
    payload: {
      access_token: "ghu_access_old",
      refresh_token: "ghr_refresh_old",
      token_type: "bearer",
      refresh_token_expires_at: "2027-02-01T12:00:00.000Z",
      github_user_id: "42",
      github_login: "octocat",
      github_installation_id: "123",
      ...overrides,
    },
    expiresAt: new Date("2026-09-01T11:00:00.000Z"),
    lastRotatedAt: new Date("2026-09-01T04:00:00.000Z"),
    refreshLeaseUntil: null,
    updatedAt: new Date("2026-09-01T04:00:00.000Z"),
    encryptionKeyVersion: 1,
  };
}

describe("GitHub user integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubEnv("OPENCOMPANY_NEXT_PUBLIC_APP_URL", "https://opencompany.example.com");
    vi.stubEnv("GITHUB_USER_APP_SLUG", "opencompany-user");
    vi.stubEnv("GITHUB_USER_APP_CLIENT_ID", "Iv1_user_client");
    vi.stubEnv("GITHUB_USER_APP_CLIENT_SECRET", "client-secret");
    vi.stubEnv("GITHUB_USER_APP_STATE_SECRET", "state-secret-state-secret-state-secret");
    vi.stubEnv("INTEGRATION_CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("signs personal state and starts the dedicated App install flow", () => {
    expect(isGitHubUserIntegrationConfigured()).toBe(true);
    const state = createGitHubUserIntegrationState({
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/github",
    });
    expect(verifyGitHubUserIntegrationState(state)).toMatchObject({
      provider: "github_user",
      userWorkosId: "user_1",
      returnTo: "/settings/plugins/github",
    });
    const install = new URL(buildGitHubUserInstallUrl(state));
    expect(install.href).toContain("github.com/apps/opencompany-user/installations/new");
    expect(install.searchParams.get("state")).toBe(state);
    expect(() => verifyGitHubUserIntegrationState(`${state}tampered`)).toThrow();
  });

  it("exchanges only expiring GitHub App user credentials and reads the account identity", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          access_token: "ghu_access_1",
          expires_in: 28_800,
          refresh_token: "ghr_refresh_1",
          refresh_token_expires_in: 15_897_600,
          token_type: "bearer",
          scope: "",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: 42, login: "octocat", name: "The Octocat", email: null }),
      );

    const tokens = await exchangeGitHubAppUserCode("authorization-code");
    await expect(fetchGitHubUserIdentity(tokens.accessToken)).resolves.toEqual({
      id: "42",
      login: "octocat",
      name: "The Octocat",
      email: null,
    });
    expect(tokens).toEqual({
      accessToken: "ghu_access_1",
      refreshToken: "ghr_refresh_1",
      tokenType: "bearer",
      accessTokenExpiresAt: new Date("2026-09-01T20:00:00.000Z"),
      refreshTokenExpiresAt: new Date("2027-03-04T12:00:00.000Z"),
    });
    const exchangeRequest = fetchMock.mock.calls[0]?.[1];
    expect(String(exchangeRequest?.body)).toContain(
      "redirect_uri=https%3A%2F%2Fopencompany.example.com",
    );

    fetchMock.mockResolvedValueOnce(
      Response.json({ access_token: "gho_wrong_token", token_type: "bearer" }),
    );
    await expect(exchangeGitHubAppUserCode("authorization-code")).rejects.toThrow(
      "expiring GitHub App user credentials",
    );
  });

  it("returns a fresh stored token without a network request", async () => {
    mocks.loadCredential.mockResolvedValue({
      ...storedCredential(),
      expiresAt: new Date("2026-09-01T13:00:00.000Z"),
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(getGitHubUserAccessToken(connection, { now })).resolves.toBe("ghu_access_old");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.rotateCredential).not.toHaveBeenCalled();
  });

  it("loads the stable account identity from the encrypted credential", async () => {
    mocks.loadCredential.mockResolvedValue(storedCredential());

    await expect(loadGitHubUserCredentialIdentity({ ...connection, db })).resolves.toEqual({
      githubUserId: "42",
      githubLogin: "octocat",
    });
    expect(mocks.loadCredential).toHaveBeenCalledWith({
      ...connection,
      provider: "github_user",
      kind: "oauth_token",
      db,
    });
  });

  it("rotates and atomically persists both expiring tokens", async () => {
    mocks.loadCredential.mockResolvedValue(storedCredential());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "ghu_access_new",
        expires_in: 28_800,
        refresh_token: "ghr_refresh_new",
        refresh_token_expires_in: 15_897_600,
        token_type: "bearer",
      }),
    );

    await expect(getGitHubUserAccessToken(connection, { now })).resolves.toBe("ghu_access_new");
    expect(mocks.rotateCredential).toHaveBeenCalledWith({
      ...connection,
      provider: "github_user",
      kind: "oauth_token",
      payload: {
        access_token: "ghu_access_new",
        refresh_token: "ghr_refresh_new",
        token_type: "bearer",
        refresh_token_expires_at: "2027-03-04T12:00:00.000Z",
        github_user_id: "42",
        github_login: "octocat",
        github_installation_id: "123",
      },
      expiresAt: new Date("2026-09-01T20:00:00.000Z"),
      expectedLastRotatedAt: new Date("2026-09-01T04:00:00.000Z"),
      expectedRefreshLeaseUntil: new Date("2026-09-01T12:00:30.000Z"),
      db,
      now,
    });
  });

  it("shares one refresh within a process for concurrent consumers", async () => {
    mocks.loadCredential.mockResolvedValue(storedCredential());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "ghu_access_new",
        expires_in: 28_800,
        refresh_token: "ghr_refresh_new",
        refresh_token_expires_in: 15_897_600,
        token_type: "bearer",
      }),
    );

    await expect(
      Promise.all([
        getGitHubUserAccessToken(connection, { now }),
        getGitHubUserAccessToken(connection, { now }),
      ]),
    ).resolves.toEqual(["ghu_access_new", "ghu_access_new"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.claimRefresh).toHaveBeenCalledOnce();
  });

  it("uses a concurrently rotated credential instead of forcing a reconnect", async () => {
    const rotatedCredential = {
      ...storedCredential({
        access_token: "ghu_access_other_worker",
        refresh_token: "ghr_refresh_other_worker",
      }),
      expiresAt: new Date("2026-09-01T20:00:00.000Z"),
      lastRotatedAt: new Date("2026-09-01T12:00:01.000Z"),
    };
    mocks.loadCredential
      .mockResolvedValueOnce(storedCredential())
      .mockResolvedValueOnce(storedCredential())
      .mockResolvedValueOnce(rotatedCredential);
    mocks.claimRefresh.mockResolvedValueOnce(false);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(getGitHubUserAccessToken(connection, { now })).resolves.toBe(
      "ghu_access_other_worker",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.markStatus).not.toHaveBeenCalled();
  });

  it("marks the connection for reauthorization when GitHub refuses its refresh token", async () => {
    mocks.loadCredential.mockResolvedValue(storedCredential());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "bad_refresh_token" }));

    await expect(getGitHubUserAccessToken(connection, { now })).rejects.toBeInstanceOf(
      GitHubUserAccessAuthError,
    );
    expect(mocks.markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        ...connection,
        provider: "github_user",
        status: "needs_reauth",
      }),
    );
  });
});
