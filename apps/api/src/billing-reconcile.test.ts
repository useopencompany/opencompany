import { sweepGoatAutoRefills } from "@opencompany/billing/auto-refill";
import { reconcileGoatStripeSeatQuantities } from "@opencompany/billing/seats";
import {
  refreshGoatMonthlyIncludedUsage,
  releasePendingGoatIngestionReservations,
} from "@opencompany/db/goat-billing";
import { reconcileGoatCapabilities } from "@opencompany/goat-agent/capabilities/reconcile";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBillingReconcileService } from "./billing-reconcile";

vi.mock("@opencompany/billing/auto-refill", () => ({ sweepGoatAutoRefills: vi.fn() }));
vi.mock("@opencompany/billing/seats", () => ({ reconcileGoatStripeSeatQuantities: vi.fn() }));
vi.mock("@opencompany/db/goat-billing", () => ({
  refreshGoatMonthlyIncludedUsage: vi.fn(),
  releasePendingGoatIngestionReservations: vi.fn(),
}));
vi.mock("@opencompany/goat-agent/capabilities/reconcile", () => ({
  reconcileGoatCapabilities: vi.fn(),
}));

describe("billing reconciliation", () => {
  const db = { marker: "api-db" };
  const stripe = { marker: "stripe-client" } as never;

  beforeEach(() => vi.clearAllMocks());

  it("rejects missing cron authentication before any billing work", async () => {
    const service = createBillingReconcileService({ db, stripe, secret: "cron-secret" });
    const response = await service.reconcile(new Request("https://api.test/billing/reconcile"));
    expect(response.status).toBe(401);
    expect(sweepGoatAutoRefills).not.toHaveBeenCalled();
  });

  it("uses the API database and Stripe client for the unchanged reconcile sequence", async () => {
    vi.mocked(reconcileGoatCapabilities).mockResolvedValue({
      expiredApprovals: 0,
      candidates: 0,
      settled: 0,
      pending: 0,
      failed: 0,
      wallet: null,
    });
    vi.mocked(releasePendingGoatIngestionReservations).mockResolvedValue({
      released: 2,
      failed: 0,
    });
    vi.mocked(refreshGoatMonthlyIncludedUsage).mockResolvedValue({
      candidates: 1,
      refreshed: 1,
      failed: 0,
    });
    vi.mocked(reconcileGoatStripeSeatQuantities).mockResolvedValue({
      candidates: 1,
      reconciled: 1,
      changed: 0,
      failed: 0,
    });
    vi.mocked(sweepGoatAutoRefills).mockResolvedValue({ candidates: 1, charged: 0 });
    const service = createBillingReconcileService({ db, stripe, secret: "cron-secret" });
    const response = await service.reconcile(
      new Request("https://api.test/billing/reconcile", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(reconcileGoatCapabilities).toHaveBeenCalledWith(100, { db });
    expect(releasePendingGoatIngestionReservations).toHaveBeenCalledWith({
      maxWorkspaces: 200,
      db,
    });
    expect(refreshGoatMonthlyIncludedUsage).toHaveBeenCalledWith({ limit: 500, db });
    expect(reconcileGoatStripeSeatQuantities).toHaveBeenCalledWith(100, { db, stripe });
    expect(sweepGoatAutoRefills).toHaveBeenCalledWith(25, { db, stripe });
  });
});
