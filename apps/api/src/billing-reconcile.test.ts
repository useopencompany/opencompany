import { reconcileCapabilities } from "@opencompany/agent/capabilities/reconcile";
import { sweepAutoRefills } from "@opencompany/billing/auto-refill";
import { reconcileStripeSeatQuantities } from "@opencompany/billing/seats";
import {
  refreshMonthlyIncludedUsage,
  releasePendingIngestionReservations,
} from "@opencompany/db/billing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBillingReconcileService } from "./billing-reconcile";

vi.mock("@opencompany/billing/auto-refill", () => ({ sweepAutoRefills: vi.fn() }));
vi.mock("@opencompany/billing/seats", () => ({ reconcileStripeSeatQuantities: vi.fn() }));
vi.mock("@opencompany/db/billing", () => ({
  refreshMonthlyIncludedUsage: vi.fn(),
  releasePendingIngestionReservations: vi.fn(),
}));
vi.mock("@opencompany/agent/capabilities/reconcile", () => ({
  reconcileCapabilities: vi.fn(),
}));

describe("billing reconciliation", () => {
  const db = { marker: "api-db" };
  const stripe = { marker: "stripe-client" } as never;

  beforeEach(() => vi.clearAllMocks());

  it("rejects missing cron authentication before any billing work", async () => {
    const service = createBillingReconcileService({ db, stripe, secret: "cron-secret" });
    const response = await service.reconcile(new Request("https://api.test/billing/reconcile"));
    expect(response.status).toBe(401);
    expect(sweepAutoRefills).not.toHaveBeenCalled();
  });

  it("uses the API database and Stripe client for the unchanged reconcile sequence", async () => {
    vi.mocked(reconcileCapabilities).mockResolvedValue({
      expiredApprovals: 0,
      candidates: 0,
      settled: 0,
      pending: 0,
      failed: 0,
      wallet: null,
    });
    vi.mocked(releasePendingIngestionReservations).mockResolvedValue({
      released: 2,
      failed: 0,
    });
    vi.mocked(refreshMonthlyIncludedUsage).mockResolvedValue({
      candidates: 1,
      refreshed: 1,
      failed: 0,
    });
    vi.mocked(reconcileStripeSeatQuantities).mockResolvedValue({
      candidates: 1,
      reconciled: 1,
      changed: 0,
      failed: 0,
    });
    vi.mocked(sweepAutoRefills).mockResolvedValue({ candidates: 1, charged: 0 });
    const service = createBillingReconcileService({ db, stripe, secret: "cron-secret" });
    const response = await service.reconcile(
      new Request("https://api.test/billing/reconcile", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(reconcileCapabilities).toHaveBeenCalledWith(100, { db });
    expect(releasePendingIngestionReservations).toHaveBeenCalledWith({
      maxWorkspaces: 200,
      db,
    });
    expect(refreshMonthlyIncludedUsage).toHaveBeenCalledWith({ limit: 500, db });
    expect(reconcileStripeSeatQuantities).toHaveBeenCalledWith(100, { db, stripe });
    expect(sweepAutoRefills).toHaveBeenCalledWith(25, { db, stripe });
  });
});
