import { listGoatSeatSyncCandidates, loadGoatBillingOverview } from "@opencompany/db/goat-billing";
import { countGoatWorkspaceMembers } from "@opencompany/db/goat-workspaces";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGoatProPriceId, getGoatStripe } from "@/lib/billing/stripe";
import { reconcileGoatSeatQuantities, syncGoatWorkspaceSeatQuantity } from "./seat-sync";

vi.mock("@opencompany/db/goat-billing", () => ({
  listGoatSeatSyncCandidates: vi.fn(),
  loadGoatBillingOverview: vi.fn(),
}));

vi.mock("@opencompany/db/goat-workspaces", () => ({
  countGoatWorkspaceMembers: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

vi.mock("@/lib/billing/stripe", () => ({
  getGoatProPriceId: vi.fn(),
  getGoatStripe: vi.fn(),
}));

describe("Goat seat billing sync", () => {
  const subscriptionItemUpdate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoatProPriceId).mockReturnValue("price_seat_18");
    vi.mocked(getGoatStripe).mockReturnValue({
      subscriptionItems: { update: subscriptionItemUpdate },
    } as never);
    vi.mocked(countGoatWorkspaceMembers).mockResolvedValue(1);
    subscriptionItemUpdate.mockResolvedValue({});
  });

  it("migrates a legacy Pro price even when the seat count is unchanged", async () => {
    vi.mocked(loadGoatBillingOverview).mockResolvedValue({
      plan: "pro",
      billing: {
        stripeSubscriptionItemId: "si_legacy",
        stripePriceId: "price_flat_99",
        seatQuantity: 1,
      },
    } as Awaited<ReturnType<typeof loadGoatBillingOverview>>);

    await syncGoatWorkspaceSeatQuantity("goat_ws_1");

    expect(subscriptionItemUpdate).toHaveBeenCalledWith("si_legacy", {
      price: "price_seat_18",
      quantity: 1,
      proration_behavior: "create_prorations",
    });
  });

  it("skips Stripe when both the price and seat count are current", async () => {
    vi.mocked(loadGoatBillingOverview).mockResolvedValue({
      plan: "pro",
      billing: {
        stripeSubscriptionItemId: "si_current",
        stripePriceId: "price_seat_18",
        seatQuantity: 2,
      },
    } as Awaited<ReturnType<typeof loadGoatBillingOverview>>);
    vi.mocked(countGoatWorkspaceMembers).mockResolvedValue(2);

    await syncGoatWorkspaceSeatQuantity("goat_ws_1");

    expect(subscriptionItemUpdate).not.toHaveBeenCalled();
  });

  it("includes legacy-price subscriptions in the hourly reconciliation", async () => {
    vi.mocked(listGoatSeatSyncCandidates).mockResolvedValue([
      {
        workspaceId: "goat_ws_1",
        stripeSubscriptionItemId: "si_legacy",
        stripePriceId: "price_flat_99",
        seatQuantity: 1,
        memberCount: 1,
      },
    ]);

    await expect(reconcileGoatSeatQuantities()).resolves.toEqual({
      candidates: 1,
      synced: 1,
      failed: 0,
    });
    expect(listGoatSeatSyncCandidates).toHaveBeenCalledWith({
      limit: 50,
      targetPriceId: "price_seat_18",
    });
    expect(subscriptionItemUpdate).toHaveBeenCalledWith(
      "si_legacy",
      expect.objectContaining({ price: "price_seat_18", quantity: 1 }),
    );
  });
});
