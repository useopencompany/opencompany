import { auth } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadIntegrationCredential,
  markIntegrationCredentialRefreshFailed,
  refreshIntegrationCredential,
} from "@/lib/integrations/credential-storage";
import {
  fetchPostHogDistinctUsers,
  POSTHOG_KPI_CREDENTIAL_KIND,
  POSTHOG_KPI_PROVIDER,
  PostHogAuthenticationError,
} from "@/lib/kpis/posthog";
import { loadMcpCredential, saveMcpCredential } from "@/lib/mcp/credential-storage";

const db = vi.hoisted(() => ({
  select: vi.fn(),
}));

const mcpOAuth = vi.hoisted(() => ({
  credential: null as null | {
    payload: Record<string, unknown>;
    expiresAt: Date | null;
    lastRotatedAt: Date | null;
    updatedAt: Date;
    encryptionKeyVersion: number;
  },
  failRefresh: false,
  nextTokens: null as null | Record<string, unknown>,
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
  loadMcpCredential: vi.fn(async () => mcpOAuth.credential),
  saveMcpCredential: vi.fn(async (input) => {
    mcpOAuth.credential = {
      payload: input.payload,
      expiresAt: input.expiresAt ?? null,
      lastRotatedAt: new Date("2026-02-08T00:00:00.000Z"),
      updatedAt: new Date("2026-02-08T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    };
  }),
}));

vi.mock("@ai-sdk/mcp", () => ({
  auth: vi.fn(async (provider) => {
    if (mcpOAuth.failRefresh) throw new Error("refresh failed");
    if (!mcpOAuth.nextTokens) return "REDIRECT";
    await provider.saveTokens(mcpOAuth.nextTokens);
    return "AUTHORIZED";
  }),
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
  mcpOAuth.credential = null;
  mcpOAuth.failRefresh = false;
  mcpOAuth.nextTokens = null;
  db.select.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => [{ id: "wmcps_posthog" }],
      }),
    }),
  });
});

describe("PostHog KPI fetch", () => {
  it("refreshes an expired MCP credential before syncing the mirrored credential", async () => {
    vi.mocked(loadIntegrationCredential).mockResolvedValueOnce({
      payload: { accessToken: "old-token" },
      expiresAt: new Date("2026-02-08T00:00:00.000Z"),
      lastRotatedAt: null,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    });
    mcpOAuth.credential = {
      payload: {
        tokens: {
          access_token: "old-mcp-token",
          token_type: "Bearer",
          refresh_token: "refresh-token",
          scope: "query:read",
        },
      },
      expiresAt: new Date(Date.now() + 60 * 1000),
      lastRotatedAt: null,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    };
    mcpOAuth.nextTokens = {
      access_token: "fresh-token",
      token_type: "Bearer",
      refresh_token: "refresh-token",
      scope: "query:read",
      expires_in: 3600,
    };
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
    expect(auth).toHaveBeenCalledTimes(1);
    expect(loadMcpCredential).toHaveBeenCalledWith({
      workspaceId: "wks_test",
      serverId: "wmcps_posthog",
      kind: "oauth",
    });
    expect(saveMcpCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "wks_test",
        serverId: "wmcps_posthog",
        kind: "oauth",
        payload: expect.objectContaining({
          tokens: expect.objectContaining({ access_token: "fresh-token" }),
        }),
      }),
    );
    expect(refreshIntegrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "wks_test",
        integrationId: "wint_posthog",
        provider: POSTHOG_KPI_PROVIDER,
        kind: POSTHOG_KPI_CREDENTIAL_KIND,
        payload: expect.objectContaining({ accessToken: "fresh-token" }),
      }),
    );
    expect(markIntegrationCredentialRefreshFailed).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledWith(
      "https://us.posthog.com/api/projects/123/query/",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer fresh-token" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("marks the integration needs_reauth after MCP token refresh fails", async () => {
    vi.mocked(loadIntegrationCredential).mockResolvedValueOnce({
      payload: { accessToken: "old-token" },
      expiresAt: new Date("2026-02-08T00:00:00.000Z"),
      lastRotatedAt: null,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    });
    mcpOAuth.credential = {
      payload: {
        tokens: {
          access_token: "old-mcp-token",
          token_type: "Bearer",
          refresh_token: "refresh-token",
        },
      },
      expiresAt: new Date(Date.now() + 60 * 1000),
      lastRotatedAt: null,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    };
    mcpOAuth.failRefresh = true;
    const fetchFn = vi.fn(async () => Response.json({ results: [[9]] })) as unknown as typeof fetch;

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

    expect(auth).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(markIntegrationCredentialRefreshFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "wks_test",
        integrationId: "wint_posthog",
        provider: POSTHOG_KPI_PROVIDER,
        status: "needs_reauth",
      }),
    );
  });

  it("uses a concurrently refreshed MCP credential before marking needs_reauth", async () => {
    vi.mocked(loadIntegrationCredential).mockResolvedValueOnce({
      payload: { accessToken: "old-token" },
      expiresAt: new Date("2026-02-08T00:00:00.000Z"),
      lastRotatedAt: null,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    });
    mcpOAuth.credential = {
      payload: {
        tokens: {
          access_token: "old-mcp-token",
          token_type: "Bearer",
          refresh_token: "refresh-token",
        },
      },
      expiresAt: new Date(Date.now() + 60 * 1000),
      lastRotatedAt: null,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    };
    vi.mocked(auth).mockImplementationOnce(async () => {
      mcpOAuth.credential = {
        payload: {
          tokens: {
            access_token: "fresh-token",
            token_type: "Bearer",
            refresh_token: "rotated-refresh-token",
            scope: "query:read",
          },
        },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        lastRotatedAt: new Date("2026-02-08T00:00:00.000Z"),
        updatedAt: new Date("2026-02-08T00:00:00.000Z"),
        encryptionKeyVersion: 1,
      };
      throw new Error("refresh failed");
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
    expect(auth).toHaveBeenCalledTimes(1);
    expect(markIntegrationCredentialRefreshFailed).not.toHaveBeenCalled();
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
    mcpOAuth.credential = {
      payload: { tokens: { access_token: "rejected-token", token_type: "Bearer" } },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastRotatedAt: null,
      updatedAt: new Date("2026-02-08T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    };
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

  it("marks the integration sync_failed when PostHog rejects query permission", async () => {
    vi.mocked(loadIntegrationCredential).mockResolvedValueOnce({
      payload: { accessToken: "posthog-token" },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      lastRotatedAt: null,
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    });
    const fetchFn = vi.fn(
      async () => new Response("forbidden", { status: 403 }),
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
    ).rejects.toMatchObject({
      message:
        "PostHog connection lacks required query permission. Reconnect PostHog to resume KPI updates.",
    });

    expect(markIntegrationCredentialRefreshFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "wks_test",
        integrationId: "wint_posthog",
        provider: POSTHOG_KPI_PROVIDER,
        status: "sync_failed",
        statusReason: expect.stringContaining("query permission"),
      }),
    );
  });
});
