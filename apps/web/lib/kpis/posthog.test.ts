import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPostHogDistinctUsers,
  PostHogAuthenticationError,
  POSTHOG_KPI_CREDENTIAL_KIND,
  POSTHOG_KPI_PROVIDER,
} from "@/lib/kpis/posthog";
import {
  loadIntegrationCredential,
  markIntegrationCredentialRefreshFailed,
  refreshIntegrationCredential,
} from "@/lib/integrations/credential-storage";
import { loadMcpCredential } from "@/lib/mcp/credential-storage";

const db = vi.hoisted(() => ({
  select: vi.fn(),
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => db,
}));

vi.mock("@/lib/integrations/credential-storage", () => ({
  loadIntegrationCredential: vi.fn(),
  markIntegrationCredentialRefreshFailed: vi.fn(async () => undefined),
  refreshIntegrationCredential: vi.fn(async () => undefined),
}));

vi.mock("@/lib/mcp/credential-storage", () => ({
  loadMcpCredential: vi.fn(),
}));

const integration = {
  id: "wint_posthog",
  workspaceId: "wks_test",
  provider: "posthog",
  externalId: "123",
  metadata: { apiHost: "https://us.posthog.com" },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.select.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => [{ id: "wmcps_posthog" }],
      }),
    }),
  });
});

describe("PostHog KPI fetch", () => {
  it("syncs an expired mirrored credential from the MCP credential before querying", async () => {
    vi.mocked(loadIntegrationCredential).mockResolvedValueOnce({
      payload: { accessToken: "old-token" },
      expiresAt: new Date("2026-02-08T00:00:00.000Z"),
      lastRotatedAt: null,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    });
    vi.mocked(loadMcpCredential).mockResolvedValueOnce({
      payload: {
        tokens: {
          access_token: "fresh-token",
          token_type: "Bearer",
          refresh_token: "refresh-token",
          scope: "query:read",
        },
      },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastRotatedAt: null,
      updatedAt: new Date("2026-02-08T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    });
    const fetchFn = vi.fn(async () => Response.json({ results: [[9]] })) as unknown as typeof fetch;

    const result = await fetchPostHogDistinctUsers({
      integration,
      window: {
        start: new Date("2026-02-07T00:00:00.000Z"),
        end: new Date("2026-02-08T00:00:00.000Z"),
      },
      fetchFn,
    });

    expect(result.value).toBe(9);
    expect(refreshIntegrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "wks_test",
        integrationId: "wint_posthog",
        provider: POSTHOG_KPI_PROVIDER,
        kind: POSTHOG_KPI_CREDENTIAL_KIND,
        payload: expect.objectContaining({ accessToken: "fresh-token" }),
      }),
    );
    expect(fetchFn).toHaveBeenCalledWith(
      "https://us.posthog.com/api/projects/123/query/",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer fresh-token" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("marks the integration needs_reauth when a fresh token is rejected", async () => {
    vi.mocked(loadIntegrationCredential).mockResolvedValueOnce({
      payload: { accessToken: "rejected-token" },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastRotatedAt: null,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    });
    vi.mocked(loadMcpCredential).mockResolvedValueOnce({
      payload: { tokens: { access_token: "rejected-token", token_type: "Bearer" } },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastRotatedAt: null,
      updatedAt: new Date("2026-02-08T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    });
    const fetchFn = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(
      fetchPostHogDistinctUsers({
        integration,
        window: {
          start: new Date("2026-02-07T00:00:00.000Z"),
          end: new Date("2026-02-08T00:00:00.000Z"),
        },
        fetchFn,
      }),
    ).rejects.toBeInstanceOf(PostHogAuthenticationError);

    expect(markIntegrationCredentialRefreshFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "wks_test",
        integrationId: "wint_posthog",
        provider: POSTHOG_KPI_PROVIDER,
        status: "needs_reauth",
      }),
    );
  });
});
