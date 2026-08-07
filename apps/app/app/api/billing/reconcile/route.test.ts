import {
  refreshGoatMonthlyIncludedUsage,
  releasePendingGoatIngestionReservations,
} from "@opencompany/db/billing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sweepGoatAutoRefills } from "@/lib/billing/auto-refill";
import { reconcileGoatStripeSeatQuantities } from "@/lib/billing/seats";
import { reconcileGoatCapabilities } from "@/lib/capabilities/reconcile";
import { GET } from "./route";

vi.mock("@opencompany/db/billing", () => ({
  refreshGoatMonthlyIncludedUsage: vi.fn(),
  releasePendingGoatIngestionReservations: vi.fn(),
}));

vi.mock("@/lib/billing/auto-refill", () => ({
  sweepGoatAutoRefills: vi.fn(),
}));

vi.mock("@/lib/billing/seats", () => ({
  reconcileGoatStripeSeatQuantities: vi.fn(),
}));

vi.mock("@/lib/capabilities/reconcile", () => ({
  reconcileGoatCapabilities: vi.fn(),
}));

describe("GET /api/billing/reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", "cron-secret");
  });

  it("rejects requests without the cron bearer secret", async () => {
    const response = await GET(new Request("https://goat.test/api/billing/reconcile"));
    expect(response.status).toBe(401);
    expect(releasePendingGoatIngestionReservations).not.toHaveBeenCalled();
    expect(refreshGoatMonthlyIncludedUsage).not.toHaveBeenCalled();
    expect(reconcileGoatStripeSeatQuantities).not.toHaveBeenCalled();
    expect(sweepGoatAutoRefills).not.toHaveBeenCalled();
    expect(reconcileGoatCapabilities).not.toHaveBeenCalled();
  });

  it("reconciles capabilities and ingestion before sweeping auto-refills", async () => {
    vi.mocked(sweepGoatAutoRefills).mockImplementation(async () => {
      return { candidates: 2, charged: 1 };
    });
    vi.mocked(releasePendingGoatIngestionReservations).mockImplementation(async () => {
      return { released: 4, failed: 1 };
    });
    vi.mocked(refreshGoatMonthlyIncludedUsage).mockResolvedValue({
      candidates: 10,
      refreshed: 3,
      failed: 0,
    });
    vi.mocked(reconcileGoatStripeSeatQuantities).mockResolvedValue({
      candidates: 2,
      reconciled: 2,
      changed: 1,
      failed: 0,
    });
    vi.mocked(reconcileGoatCapabilities).mockResolvedValue({
      expiredApprovals: 1,
      candidates: 3,
      settled: 2,
      pending: 1,
      failed: 0,
      wallet: null,
    });
    const response = await GET(
      new Request("https://goat.test/api/billing/reconcile", {
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
    expect(reconcileGoatCapabilities).toHaveBeenCalledWith(100);
    expect(refreshGoatMonthlyIncludedUsage).toHaveBeenCalledWith({ limit: 500 });
    expect(reconcileGoatStripeSeatQuantities).toHaveBeenCalledWith(100);
    expect(sweepGoatAutoRefills).toHaveBeenCalledWith(25);
  });
});
