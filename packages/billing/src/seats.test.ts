import {
  listStripeSeatReconciliationCandidates,
  loadBillingOverview,
  reconcileStripeSeatQuantity,
} from "@opencompany/db/billing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileStripeSeatQuantities, syncStripeSeatQuantityForWorkspace } from "./seats";
import { getStripe } from "./stripe";

vi.mock("@opencompany/db/billing", () => ({
  listStripeSeatReconciliationCandidates: vi.fn(),
  loadBillingOverview: vi.fn(),
  reconcileStripeSeatQuantity: vi.fn(),
}));

vi.mock("./stripe", () => ({
  getStripe: vi.fn(),
}));

describe("opencompany Stripe seat reconciliation", () => {
  const retrieve = vi.fn();
  const update = vi.fn();
  const db = {};

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStripe).mockReturnValue({
      subscriptionItems: { retrieve, update },
    } as never);
    vi.mocked(reconcileStripeSeatQuantity).mockResolvedValue({
      ok: true,
      seatQuantity: 2,
      grant: { ok: true },
    } as never);
  });

  it("updates Stripe with proration before projecting a new paid seat", async () => {
    vi.mocked(loadBillingOverview).mockResolvedValue({
      billing: {
        plan: "pro",
        subscriptionStatus: "active",
        stripeSubscriptionItemId: "si_1",
        seatQuantity: 1,
      },
      memberCount: 2,
    } as never);
    retrieve.mockResolvedValue({ quantity: 1 });
    update.mockResolvedValue({ quantity: 2 });

    await expect(syncStripeSeatQuantityForWorkspace("goat_ws_1", { db })).resolves.toEqual({
      ok: true,
      changed: true,
      quantity: 2,
    });
    expect(update).toHaveBeenCalledWith("si_1", {
      quantity: 2,
      proration_behavior: "create_prorations",
    });
    expect(update).toHaveBeenCalledBefore(vi.mocked(reconcileStripeSeatQuantity));
    expect(reconcileStripeSeatQuantity).toHaveBeenCalledWith(
      {
        workspaceId: "goat_ws_1",
        seatQuantity: 2,
      },
      { db },
    );
  });

  it("repairs the local projection even when Stripe already has the right quantity", async () => {
    vi.mocked(loadBillingOverview).mockResolvedValue({
      billing: {
        plan: "pro",
        subscriptionStatus: "active",
        stripeSubscriptionItemId: "si_1",
        seatQuantity: 1,
      },
      memberCount: 2,
    } as never);
    retrieve.mockResolvedValue({ quantity: 2 });

    await expect(syncStripeSeatQuantityForWorkspace("goat_ws_1", { db })).resolves.toMatchObject({
      ok: true,
      changed: false,
      quantity: 2,
    });
    expect(update).not.toHaveBeenCalled();
    expect(reconcileStripeSeatQuantity).toHaveBeenCalledWith(
      {
        workspaceId: "goat_ws_1",
        seatQuantity: 2,
      },
      { db },
    );
  });

  it("skips Stripe for Hobby", async () => {
    vi.mocked(loadBillingOverview).mockResolvedValue({
      billing: {
        plan: "hobby",
        subscriptionStatus: null,
        stripeSubscriptionItemId: null,
      },
      memberCount: 1,
    } as never);

    await expect(syncStripeSeatQuantityForWorkspace("goat_ws_1", { db })).resolves.toEqual({
      ok: false,
      reason: "no_active_subscription",
    });
    expect(getStripe).not.toHaveBeenCalled();
  });

  it("continues the hourly sweep when one workspace fails", async () => {
    vi.mocked(listStripeSeatReconciliationCandidates).mockResolvedValue(["goat_ws_1", "goat_ws_2"]);
    vi.mocked(loadBillingOverview)
      .mockRejectedValueOnce(new Error("Stripe unavailable"))
      .mockResolvedValueOnce({
        billing: {
          plan: "pro",
          subscriptionStatus: "active",
          stripeSubscriptionItemId: "si_2",
          seatQuantity: 1,
        },
        memberCount: 1,
      } as never);
    retrieve.mockResolvedValue({ quantity: 1 });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(reconcileStripeSeatQuantities(25, { db })).resolves.toEqual({
      candidates: 2,
      reconciled: 1,
      changed: 0,
      failed: 1,
    });
    expect(listStripeSeatReconciliationCandidates).toHaveBeenCalledWith({ limit: 25, db });
    consoleError.mockRestore();
  });
});
