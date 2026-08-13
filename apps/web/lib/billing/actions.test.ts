import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serverApiClient, serverApiErrorMessage } from "@/lib/server-api-client";
import {
  createGoatBillingPortalAction,
  createGoatCreditTopUpAction,
  createGoatProCheckoutAction,
  setGoatAutoRefillAction,
} from "./actions";

vi.mock("@/lib/server-api-client", () => ({
  serverApiClient: vi.fn(),
  serverApiErrorMessage: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

describe("Goat billing API adapters", () => {
  const topUp = vi.fn();
  const subscription = vi.fn();
  const portal = vi.fn();
  const autoRefill = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(serverApiClient).mockResolvedValue({
      v1: {
        billing: {
          "top-ups": { $post: topUp },
          "subscription-checkouts": { $post: subscription },
          "portal-sessions": { $post: portal },
          "auto-refill": { $put: autoRefill },
        },
      },
    } as never);
    for (const command of [topUp, subscription, portal]) {
      command.mockResolvedValue(
        Response.json({ data: { redirectUrl: "https://checkout.stripe.test/session" } }),
      );
    }
    autoRefill.mockResolvedValue(Response.json({ data: { updated: true } }));
  });

  it("forwards an explicit idempotency key for every billing command", async () => {
    await expect(createGoatCreditTopUpAction(1_000, "topup-1")).rejects.toThrow("NEXT_REDIRECT");
    await expect(createGoatProCheckoutAction("subscription-1")).rejects.toThrow("NEXT_REDIRECT");
    await expect(createGoatBillingPortalAction("portal-1")).rejects.toThrow("NEXT_REDIRECT");
    await expect(
      setGoatAutoRefillAction({ enabled: true, amountCents: 2_000 }, "refill-1"),
    ).resolves.toEqual({ ok: true });

    expect(topUp).toHaveBeenCalledWith({
      header: { "idempotency-key": "topup-1" },
      json: { amountCents: 1_000 },
    });
    expect(subscription).toHaveBeenCalledWith({
      header: { "idempotency-key": "subscription-1" },
    });
    expect(portal).toHaveBeenCalledWith({ header: { "idempotency-key": "portal-1" } });
    expect(autoRefill).toHaveBeenCalledWith({
      header: { "idempotency-key": "refill-1" },
      json: { enabled: true, amountCents: 2_000 },
    });
    expect(redirect).toHaveBeenCalledTimes(3);
  });

  it("returns the canonical API error without touching Stripe in web", async () => {
    const failed = Response.json({ error: { message: "Admin only." } }, { status: 403 });
    topUp.mockResolvedValueOnce(failed);
    vi.mocked(serverApiErrorMessage).mockResolvedValueOnce("Admin only.");

    await expect(createGoatCreditTopUpAction(1_000, "topup-2")).resolves.toEqual({
      ok: false,
      error: "Admin only.",
    });
    expect(redirect).not.toHaveBeenCalled();
  });
});
