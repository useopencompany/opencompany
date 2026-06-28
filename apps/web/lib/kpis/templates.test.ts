import { auth } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadIntegrationCredential,
  markIntegrationCredentialRefreshFailed,
} from "@/lib/integrations/credential-storage";
import { KPI_TEMPLATE_CATALOG } from "@/lib/kpis/templates";

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
  nextTokens: null as null | Record<string, unknown>,
}));

vi.mock("@opencompany/db/client", () => ({
  getDb: () => db,
}));

vi.mock("@/lib/integrations/credential-storage", () => ({
  loadIntegrationCredential: vi.fn(async () => ({
    payload: { accessToken: "posthog-token" },
    expiresAt: null,
    lastRotatedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    encryptionKeyVersion: 1,
  })),
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
    await new Promise((resolve) => setTimeout(resolve, 10));
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

describe("PostHog KPI templates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mcpOAuth.credential = null;
    mcpOAuth.nextTokens = null;
    vi.mocked(loadIntegrationCredential).mockResolvedValue({
      payload: { accessToken: "posthog-token" },
      expiresAt: null,
      lastRotatedAt: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      encryptionKeyVersion: 1,
    });
    db.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: "wmcps_posthog" }],
        }),
      }),
    });
  });

  it("computes the latest stored point", () => {
    const template = KPI_TEMPLATE_CATALOG.posthog.posthog_dau;

    expect(
      template.compute([
        { pointAt: new Date("2026-01-01T00:00:00.000Z"), value: "10" },
        { pointAt: new Date("2026-01-02T00:00:00.000Z"), value: "14" },
      ]),
    ).toBe(14);
  });

  it("fetches DAU with distinct users over current and previous 24h windows", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ results: [[42]], is_cached: false }),
    ) as unknown as typeof fetch;
    const template = KPI_TEMPLATE_CATALOG.posthog.posthog_dau;

    const result = await template.liveFetch({
      integration,
      timeGrain: "day",
      filterParams: { mode: "template", version: 1, values: {} },
      now: new Date("2026-02-08T12:00:00.000Z"),
      fetchFn: fetchMock,
    });

    expect(result.current).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://us.posthog.com/api/projects/123/query/",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer posthog-token" }),
      }),
    );
    const body = JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]?.[1]?.body));
    expect(body.query.kind).toBe("HogQLQuery");
    expect(body.query.query).toContain("count(DISTINCT distinct_id)");
    expect(body.query.query).toContain("timestamp >=");
    expect(body.query.query).toContain("'2026-02-07T12:00:00.000Z'");
    expect(body.query.query).toContain("'2026-02-08T12:00:00.000Z'");
    expect(result.source?.current).toEqual(
      expect.objectContaining({
        provider: "posthog",
        queryName: "opencompany_kpi_distinct_users",
        projectId: "123",
        isCached: false,
        window: {
          start: "2026-02-07T12:00:00.000Z",
          end: "2026-02-08T12:00:00.000Z",
        },
      }),
    );
    expect(JSON.stringify(result.source)).not.toContain("results");
    expect(JSON.stringify(result.source)).not.toContain("SELECT");
  });

  it("refreshes a near-expired MCP credential once for current and previous windows", async () => {
    vi.mocked(loadIntegrationCredential).mockResolvedValue({
      payload: { accessToken: "old-token" },
      expiresAt: new Date(Date.now() + 60 * 1000),
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
      refresh_token: "rotated-refresh-token",
      scope: "query:read",
      expires_in: 3600,
    };
    const fetchMock = vi.fn(async () =>
      Response.json({ results: [[42]], is_cached: false }),
    ) as unknown as typeof fetch;
    const template = KPI_TEMPLATE_CATALOG.posthog.posthog_dau;

    const result = await template.liveFetch({
      integration,
      timeGrain: "day",
      filterParams: { mode: "template", version: 1, values: {} },
      now: new Date("2026-02-08T12:00:00.000Z"),
      fetchFn: fetchMock,
    });

    expect(result).toMatchObject({ current: 42, previous: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(auth).toHaveBeenCalledTimes(1);
    expect(markIntegrationCredentialRefreshFailed).not.toHaveBeenCalled();
    for (const call of vi.mocked(fetchMock).mock.calls) {
      expect(call[1]?.headers).toEqual(
        expect.objectContaining({ authorization: "Bearer fresh-token" }),
      );
    }
  });

  it("fetches Signups as a count of configured event names", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ results: [[7]] }),
    ) as unknown as typeof fetch;
    const template = KPI_TEMPLATE_CATALOG.posthog.posthog_signups;

    const result = await template.liveFetch({
      integration,
      timeGrain: "week",
      filterParams: { mode: "template", version: 1, values: { eventNames: "signup, $identify" } },
      now: new Date("2026-02-08T12:00:00.000Z"),
      fetchFn: fetchMock,
    });

    expect(result.current).toBe(7);
    const body = JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]?.[1]?.body));
    expect(body.query.query).toContain("SELECT count()");
    expect(body.query.query).toContain("event IN ('signup', '$identify')");
  });
});
