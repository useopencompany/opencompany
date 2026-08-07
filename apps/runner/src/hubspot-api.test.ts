import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnerEnv } from "./env";

const integrationsMock = vi.hoisted(() => ({
  loadGoatIntegrationCredential: vi.fn(),
  markGoatIntegrationStatus: vi.fn(),
  refreshGoatIntegrationCredential: vi.fn(),
}));

vi.mock("@opencompany/db/integrations", () => integrationsMock);
vi.mock("@opencompany/observability", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("./db", () => ({ getDb: () => ({}) }));

import { getHubspotAccessToken } from "./hubspot-api";

const fetchMock = vi.fn<typeof fetch>();
const env = {
  hubspotOAuthClientId: "hubspot-client-id",
  hubspotOAuthClientSecret: "hubspot-client-secret",
} as RunnerEnv;

describe("HubSpot API OAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    integrationsMock.loadGoatIntegrationCredential.mockResolvedValue({
      payload: {
        access_token: "expired-access-token",
        refresh_token: "refresh-token",
      },
      expiresAt: new Date(Date.now() - 60_000),
      lastRotatedAt: new Date(),
      updatedAt: new Date(),
      encryptionKeyVersion: 1,
    });
    integrationsMock.refreshGoatIntegrationCredential.mockResolvedValue({});
    fetchMock.mockResolvedValue(
      Response.json({
        access_token: "fresh-access-token",
        refresh_token: "fresh-refresh-token",
        expires_in: 1800,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes access tokens through the 2026-03 endpoint", async () => {
    await expect(
      getHubspotAccessToken({
        env,
        userWorkosId: "user_1",
        integrationId: "gint_hubspot_1",
      }),
    ).resolves.toBe("fresh-access-token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.hubapi.com/oauth/2026-03/token",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchMock.mock.calls[0]?.[1];
    const body = new URLSearchParams(String(request?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token");
    expect(integrationsMock.refreshGoatIntegrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
        },
      }),
    );
  });
});
