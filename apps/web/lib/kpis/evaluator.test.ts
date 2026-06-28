import { describe, expect, it, vi } from "vitest";
import { markIntegrationCredentialRefreshFailed } from "@/lib/integrations/credential-storage";
import { evaluateKpiWithDependencies, evaluationWindow, grainBoundary } from "@/lib/kpis/evaluator";

vi.mock("@/lib/integrations/credential-storage", () => ({
  loadIntegrationCredential: vi.fn(async () => ({
    payload: { accessToken: "posthog-token" },
    expiresAt: null,
    lastRotatedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    encryptionKeyVersion: 1,
  })),
  markIntegrationCredentialRefreshFailed: vi.fn(async () => undefined),
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
    const storedValue = vi.mocked(upsertValue).mock.calls[0]?.[0];
    expect(storedValue).toEqual(
      expect.objectContaining({
        kpiId: "wkpi_test",
        pointAt: new Date("2026-02-07T00:00:00.000Z"),
        value: 21,
        grain: "day",
      }),
    );
    expect(storedValue?.source.window).toEqual({
      start: "2026-02-07T00:00:00.000Z",
      end: "2026-02-08T00:00:00.000Z",
    });
    expect(markKpiStatus).toHaveBeenCalledWith("active", null);
  });

  it("keeps retryable fetch failures scheduled and does not poison values", async () => {
    const upsertValue = vi.fn(async () => {});
    const markKpiStatus = vi.fn(async () => {});
    const fetchFn = vi.fn(
      async () => new Response("nope", { status: 500 }),
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
    expect(markKpiStatus).toHaveBeenCalledWith("active", "PostHog Query API returned 500.");
  });

  it("marks PostHog 403 as an integration permission failure instead of a retryable fetch error", async () => {
    const upsertValue = vi.fn(async () => {});
    const markKpiStatus = vi.fn(async () => {});
    const fetchFn = vi.fn(
      async () => new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch;

    const result = await evaluateKpiWithDependencies({
      kpi: baseKpi,
      integration,
      now: new Date("2026-02-08T12:30:00.000Z"),
      fetchFn,
      upsertValue,
      markKpiStatus,
    });

    expect(result).toEqual({
      status: "failed",
      kpiId: "wkpi_test",
      reason:
        "PostHog connection lacks required query permission. Reconnect PostHog to resume KPI updates.",
    });
    expect(upsertValue).not.toHaveBeenCalled();
    expect(markIntegrationCredentialRefreshFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "wks_test",
        integrationId: "wint_posthog",
        provider: "posthog",
        status: "sync_failed",
      }),
    );
    expect(markKpiStatus).toHaveBeenCalledWith(
      "fetch_failed",
      "PostHog connection lacks required query permission. Reconnect PostHog to resume KPI updates.",
    );
    expect(markKpiStatus).not.toHaveBeenCalledWith("active", "PostHog Query API returned 403.");
  });

  it("uses Monday UTC as the week grain boundary", () => {
    expect(grainBoundary("week", new Date("2026-02-08T12:00:00.000Z")).toISOString()).toBe(
      "2026-02-02T00:00:00.000Z",
    );
  });

  it("stores the last completed UTC bucket for scheduled evaluation", () => {
    expect(evaluationWindow("day", new Date("2026-02-08T02:15:00.000Z"))).toEqual({
      start: new Date("2026-02-07T00:00:00.000Z"),
      end: new Date("2026-02-08T00:00:00.000Z"),
    });
    expect(evaluationWindow("week", new Date("2026-02-09T02:15:00.000Z"))).toEqual({
      start: new Date("2026-02-02T00:00:00.000Z"),
      end: new Date("2026-02-09T00:00:00.000Z"),
    });
  });
});
