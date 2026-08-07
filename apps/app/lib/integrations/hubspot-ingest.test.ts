import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeHubspotCode, fetchHubspotIdentity } from "./hubspot-ingest";

const fetchMock = vi.fn<typeof fetch>();

describe("HubSpot OAuth", () => {
  beforeEach(() => {
    vi.stubEnv("HUBSPOT_CLIENT_ID", "hubspot-client-id");
    vi.stubEnv("HUBSPOT_CLIENT_SECRET", "hubspot-client-secret");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("exchanges authorization codes through the 2026-03 token endpoint", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 1800,
      }),
    );

    const result = await exchangeHubspotCode("authorization-code");

    expect(result).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.hubapi.com/oauth/2026-03/token",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetchMock.mock.calls[0]?.[1];
    const body = new URLSearchParams(String(request?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("authorization-code");
    expect(body.get("client_secret")).toBe("hubspot-client-secret");
  });

  it("introspects access tokens with a form-encoded POST body", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        active: true,
        hub_id: 62515,
        hub_domain: "acme.example",
        user: "owner@acme.example",
        scopes: [
          "oauth",
          "crm.objects.contacts.read",
          "crm.objects.companies.read",
          "crm.objects.deals.read",
        ],
      }),
    );

    await expect(fetchHubspotIdentity("sensitive-access-token")).resolves.toEqual({
      portalId: "62515",
      hubDomain: "acme.example",
      userEmail: "owner@acme.example",
      scopes: [
        "oauth",
        "crm.objects.contacts.read",
        "crm.objects.companies.read",
        "crm.objects.deals.read",
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.hubapi.com/oauth/2026-03/token/introspect",
      expect.objectContaining({ method: "POST" }),
    );
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("sensitive-access-token");
    const body = new URLSearchParams(String(request?.body));
    expect(body.get("token_type_hint")).toBe("access_token");
    expect(body.get("token")).toBe("sensitive-access-token");
    expect(body.get("client_id")).toBe("hubspot-client-id");
  });

  it("rejects inactive access tokens", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ active: false }));

    await expect(fetchHubspotIdentity("inactive-token")).rejects.toThrow("inactive access token");
  });
});
