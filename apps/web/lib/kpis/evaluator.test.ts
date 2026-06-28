import { describe, expect, it, vi } from "vitest";
import { evaluateKpiWithDependencies, grainBoundary } from "@/lib/kpis/evaluator";

vi.mock("@/lib/integrations/credential-storage", () => ({
  loadIntegrationCredential: vi.fn(async () => ({
    payload: { accessToken: "posthog-token" },
    expiresAt: null,
    lastRotatedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    encryptionKeyVersion: 1,
  })),
}));

const baseKpi = {
  id: "wkpi_test",
  workspaceId: "wks_test",
  provider: "posthog",
  templateId: "posthog_dau",
  timeGrain: "day" as const,
  filterParams: { mode: "template", version: 1, values: {} },
  status: "active" as const,
};

const integration = {
  id: "wint_posthog",
  workspaceId: "wks_test",
  provider: "posthog",
  externalId: "123",
  metadata: { apiHost: "https://us.posthog.com" },
};

describe("KPI evaluator", () => {
  it("upserts the current live value and marks the KPI active", async () => {
    const upsertValue = vi.fn(async () => {});
    const markKpiStatus = vi.fn(async () => {});
    const fetchFn = vi.fn(async () =>
      Response.json({ results: [[21]] }),
    ) as unknown as typeof fetch;
    const now = new Date("2026-02-08T12:30:00.000Z");

    const result = await evaluateKpiWithDependencies({
      kpi: baseKpi,
      integration,
      now,
      fetchFn,
      upsertValue,
      markKpiStatus,
    });

    expect(result).toMatchObject({ status: "stored", kpiId: "wkpi_test", value: 21 });
    expect(upsertValue).toHaveBeenCalledWith(
      expect.objectContaining({
        kpiId: "wkpi_test",
        pointAt: new Date("2026-02-08T00:00:00.000Z"),
        value: 21,
        grain: "day",
      }),
    );
    expect(markKpiStatus).toHaveBeenCalledWith("active", null);
  });

  it("marks fetch_failed and does not poison values when live fetch fails", async () => {
    const upsertValue = vi.fn(async () => {});
    const markKpiStatus = vi.fn(async () => {});
    const fetchFn = vi.fn(
      async () => new Response("nope", { status: 401 }),
    ) as unknown as typeof fetch;

    const result = await evaluateKpiWithDependencies({
      kpi: baseKpi,
      integration,
      now: new Date("2026-02-08T12:30:00.000Z"),
      fetchFn,
      upsertValue,
      markKpiStatus,
    });

    expect(result.status).toBe("failed");
    expect(upsertValue).not.toHaveBeenCalled();
    expect(markKpiStatus).toHaveBeenCalledWith("fetch_failed", "PostHog Query API returned 401.");
  });

  it("uses Monday UTC as the week grain boundary", () => {
    expect(grainBoundary("week", new Date("2026-02-08T12:00:00.000Z")).toISOString()).toBe(
      "2026-02-02T00:00:00.000Z",
    );
  });
});
