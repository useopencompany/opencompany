import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  claim: vi.fn(),
  rotate: vi.fn(),
  release: vi.fn(),
  mark: vi.fn(),
}));
vi.mock("@opencompany/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@opencompany/db/integrations", () => ({
  loadIntegrationCredential: mocks.load,
  claimIntegrationCredentialRefresh: mocks.claim,
  rotateIntegrationCredential: mocks.rotate,
  releaseIntegrationCredentialRefresh: mocks.release,
  markIntegrationStatus: mocks.mark,
}));

import { getMicrosoftAccessToken, graphApiCall, graphApiDownload } from "./microsoft-access-token";

const connection = {
  provider: "outlook" as const,
  integrationId: "integration_1",
  userWorkosId: "user_1",
};
const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
const credential = (expired = false) => ({
  payload: { access_token: "old-access", refresh_token: "old-refresh" },
  expiresAt: new Date(Date.now() + (expired ? -10000 : 3600000)),
  lastRotatedAt: new Date(0),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockResolvedValue(credential());
  mocks.claim.mockResolvedValue(true);
  mocks.rotate.mockResolvedValue(true);
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", "client");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const refreshed = () =>
  Response.json({
    access_token: "new-access",
    refresh_token: "new-refresh",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "User.Read Mail.ReadWrite",
  });
describe("Microsoft credentials and Graph", () => {
  it("leases refresh and rotates the encrypted credential with the new refresh token", async () => {
    mocks.load.mockResolvedValue(credential(true));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(refreshed()));
    expect(await getMicrosoftAccessToken(connection)).toBe("new-access");
    expect(mocks.claim).toHaveBeenCalledOnce();
    expect(mocks.rotate).toHaveBeenCalledWith(
      expect.objectContaining({
        ...connection,
        kind: "oauth_token",
        payload: expect.objectContaining({ refresh_token: "new-refresh" }),
        expectedRefreshLeaseUntil: expect.any(Date),
      }),
    );
  });
  it("shares one refresh for concurrent callers", async () => {
    mocks.load.mockResolvedValue(credential(true));
    const fetch = vi.fn().mockResolvedValue(refreshed());
    vi.stubGlobal("fetch", fetch);
    expect(
      await Promise.all([getMicrosoftAccessToken(connection), getMicrosoftAccessToken(connection)]),
    ).toEqual(["new-access", "new-access"]);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("forces refresh once after a Graph 401", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(refreshed())
      .mockResolvedValueOnce(Response.json({ value: [] }));
    vi.stubGlobal("fetch", fetch);
    expect(await graphApiCall(connection, "GET", url)).toEqual({ value: [] });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]![1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: "Bearer new-access" },
    });
  });
  it("marks revoked refresh tokens as requiring reauthorization", async () => {
    mocks.load.mockResolvedValue(credential(true));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "invalid_grant", error_description: "private" }, { status: 400 }),
        ),
    );
    await expect(getMicrosoftAccessToken(connection)).rejects.toThrow("Reconnect");
    expect(mocks.mark).toHaveBeenCalledWith(expect.objectContaining({ status: "needs_reauth" }));
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("marks repeated API rejection as requiring reauthorization without retries beyond one", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(refreshed())
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(graphApiCall(connection, "GET", url)).rejects.toThrow("Reconnect");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(mocks.mark).toHaveBeenCalledWith(expect.objectContaining({ status: "needs_reauth" }));
  });
  it.each([
    "https://evil.example/v1.0/me/messages",
    "https://graph.microsoft.com/v1.0/users/other/messages",
    "https://graph.microsoft.com.evil.example/v1.0/me/messages",
    "https://user@graph.microsoft.com/v1.0/me/messages",
  ])("rejects untrusted URLs before loading credentials: %s", async (target) => {
    await expect(graphApiCall(connection, "GET", new URL(target))).rejects.toThrow("Untrusted");
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("bounds binary streams even without content-length", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(20))));
    await expect(graphApiDownload(connection, url, { maxBytes: 10 })).rejects.toThrow("exceeds");
  });
  it("does not treat permission policy or throttling failures as token revocation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("private-data", { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    await expect(graphApiCall(connection, "GET", url)).rejects.toThrow("consent policy");
    await expect(graphApiCall(connection, "GET", url)).rejects.toThrow("rate limiting");
    expect(mocks.mark).not.toHaveBeenCalled();
  });
});
