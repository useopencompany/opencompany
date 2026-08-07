import {
  listGoatStripeSeatReconciliationCandidates,
  loadGoatBillingOverview,
  reconcileGoatStripeSeatQuantity,
} from "@opencompany/db/billing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGoatStripe } from "@/lib/billing/stripe";
import { reconcileGoatStripeSeatQuantities, syncGoatStripeSeatQuantityForWorkspace } from "./seats";

vi.mock("@opencompany/db/billing", () => ({
  listGoatStripeSeatReconciliationCandidates: vi.fn(),
  loadGoatBillingOverview: vi.fn(),
  reconcileGoatStripeSeatQuantity: vi.fn(),
}));

vi.mock("@/lib/billing/stripe", () => ({
  getGoatStripe: vi.fn(),
}));

describe("Goat Stripe seat reconciliation", () => {
  const retrieve = vi.fn();
  const update = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoatStripe).mockReturnValue({
      subscriptionItems: { retrieve, update },
    } as never);
    vi.mocked(reconcileGoatStripeSeatQuantity).mockResolvedValue({
      ok: true,
      seatQuantity: 2,
      grant: { ok: true },
    } as never);
  });

  it("updates Stripe with proration before projecting a new paid seat", async () => {
    vi.mocked(loadGoatBillingOverview).mockResolvedValue({
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

    await expect(syncGoatStripeSeatQuantityForWorkspace("goat_ws_1")).resolves.toEqual({
      ok: true,
      changed: true,
      quantity: 2,
    });
    expect(update).toHaveBeenCalledWith("si_1", {
      quantity: 2,
      proration_behavior: "create_prorations",
    });
    expect(update).toHaveBeenCalledBefore(vi.mocked(reconcileGoatStripeSeatQuantity));
    expect(reconcileGoatStripeSeatQuantity).toHaveBeenCalledWith({
      workspaceId: "goat_ws_1",
      seatQuantity: 2,
    });
  });

  it("repairs the local projection even when Stripe already has the right quantity", async () => {
    vi.mocked(loadGoatBillingOverview).mockResolvedValue({
      billing: {
        plan: "pro",
        subscriptionStatus: "active",
        stripeSubscriptionItemId: "si_1",
        seatQuantity: 1,
      },
      memberCount: 2,
    } as never);
    retrieve.mockResolvedValue({ quantity: 2 });

    await expect(syncGoatStripeSeatQuantityForWorkspace("goat_ws_1")).resolves.toMatchObject({
      ok: true,
      changed: false,
      quantity: 2,
    });
    expect(update).not.toHaveBeenCalled();
    expect(reconcileGoatStripeSeatQuantity).toHaveBeenCalledWith({
      workspaceId: "goat_ws_1",
      seatQuantity: 2,
    });
  });

  it("skips Stripe for Hobby", async () => {
    vi.mocked(loadGoatBillingOverview).mockResolvedValue({
      billing: {
        plan: "hobby",
        subscriptionStatus: null,
        stripeSubscriptionItemId: null,
      },
      memberCount: 1,
    } as never);

    await expect(syncGoatStripeSeatQuantityForWorkspace("goat_ws_1")).resolves.toEqual({
      ok: false,
      reason: "no_active_subscription",
    });
    expect(getGoatStripe).not.toHaveBeenCalled();
  });

  it("continues the hourly sweep when one workspace fails", async () => {
    vi.mocked(listGoatStripeSeatReconciliationCandidates).mockResolvedValue([
      "goat_ws_1",
      "goat_ws_2",
    ]);
    vi.mocked(loadGoatBillingOverview)
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

    await expect(reconcileGoatStripeSeatQuantities(25)).resolves.toEqual({
      candidates: 2,
      reconciled: 1,
      changed: 0,
      failed: 1,
    });
    expect(listGoatStripeSeatReconciliationCandidates).toHaveBeenCalledWith({ limit: 25 });
    consoleError.mockRestore();
  });
});
