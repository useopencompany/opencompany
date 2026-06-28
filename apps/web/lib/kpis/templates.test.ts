import { describe, expect, it, vi } from "vitest";
import { KPI_TEMPLATE_CATALOG } from "@/lib/kpis/templates";

vi.mock("@/lib/integrations/credential-storage", () => ({
  loadIntegrationCredential: vi.fn(async () => ({
    payload: { accessToken: "posthog-token" },
    expiresAt: null,
    lastRotatedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    encryptionKeyVersion: 1,
  })),
}));

const integration = {
  id: "wint_posthog",
  workspaceId: "wks_test",
  provider: "posthog",
  externalId: "123",
  metadata: { apiHost: "https://us.posthog.com" },
};

describe("PostHog KPI templates", () => {
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
