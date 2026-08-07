import {
  refreshMonthlyIncludedUsage,
  releasePendingIngestionReservations,
} from "@opencompany/db/billing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sweepAutoRefills } from "@/lib/billing/auto-refill";
import { reconcileStripeSeatQuantities } from "@/lib/billing/seats";
import { reconcileCapabilities } from "@/lib/capabilities/reconcile";
import { GET } from "./route";

vi.mock("@opencompany/db/billing", () => ({
  refreshMonthlyIncludedUsage: vi.fn(),
  releasePendingIngestionReservations: vi.fn(),
}));

vi.mock("@/lib/billing/auto-refill", () => ({
  sweepAutoRefills: vi.fn(),
}));

vi.mock("@/lib/billing/seats", () => ({
  reconcileStripeSeatQuantities: vi.fn(),
}));

vi.mock("@/lib/capabilities/reconcile", () => ({
  reconcileCapabilities: vi.fn(),
}));

describe("GET /api/billing/reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "cron-secret");
  });

  it("rejects requests without the cron bearer secret", async () => {
    const response = await GET(new Request("https://app.test/api/billing/reconcile"));
    expect(response.status).toBe(401);
    expect(releasePendingIngestionReservations).not.toHaveBeenCalled();
    expect(refreshMonthlyIncludedUsage).not.toHaveBeenCalled();
    expect(reconcileStripeSeatQuantities).not.toHaveBeenCalled();
    expect(sweepAutoRefills).not.toHaveBeenCalled();
    expect(reconcileCapabilities).not.toHaveBeenCalled();
  });

  it("reconciles capabilities and ingestion before sweeping auto-refills", async () => {
    vi.mocked(sweepAutoRefills).mockImplementation(async () => {
      return { candidates: 2, charged: 1 };
    });
    vi.mocked(releasePendingIngestionReservations).mockImplementation(async () => {
      return { released: 4, failed: 1 };
    });
    vi.mocked(refreshMonthlyIncludedUsage).mockResolvedValue({
      candidates: 10,
      refreshed: 3,
      failed: 0,
    });
    vi.mocked(reconcileStripeSeatQuantities).mockResolvedValue({
      candidates: 2,
      reconciled: 2,
      changed: 1,
      failed: 0,
    });
    vi.mocked(reconcileCapabilities).mockResolvedValue({
      expiredApprovals: 1,
      candidates: 3,
      settled: 2,
      pending: 1,
      failed: 0,
      wallet: null,
    });
    const response = await GET(
      new Request("https://app.test/api/billing/reconcile", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      released: 4,
      failed: 1,
      autoRefills: { candidates: 2, charged: 1 },
      includedUsage: { candidates: 10, refreshed: 3, failed: 0 },
      seats: { candidates: 2, reconciled: 2, changed: 1, failed: 0 },
      capabilities: {
        expiredApprovals: 1,
        candidates: 3,
        settled: 2,
        pending: 1,
        failed: 0,
        wallet: null,
      },
    });
    expect(reconcileCapabilities).toHaveBeenCalledWith(100);
    expect(refreshMonthlyIncludedUsage).toHaveBeenCalledWith({ limit: 500 });
    expect(reconcileStripeSeatQuantities).toHaveBeenCalledWith(100);
    expect(sweepAutoRefills).toHaveBeenCalledWith(25);
  });
});
