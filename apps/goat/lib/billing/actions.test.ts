import { loadGoatBillingOverview, setGoatAutoRefillConfig } from "@opencompany/db/goat-billing";
import {
  createGoatPendingCheckoutRecord,
  markGoatCheckoutRecordOpen,
} from "@opencompany/db/goat-credits";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { getGoatStripe } from "@/lib/billing/stripe";
import { createGoatCreditTopUpAction, setGoatAutoRefillAction } from "./actions";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@opencompany/db/goat-billing", () => ({
  loadGoatBillingOverview: vi.fn(),
  setGoatAutoRefillConfig: vi.fn(),
  setGoatStripeCustomerId: vi.fn(),
}));

vi.mock("@opencompany/db/goat-credits", () => ({
  createGoatPendingCheckoutRecord: vi.fn().mockResolvedValue(undefined),
  markGoatCheckoutRecordFailed: vi.fn().mockResolvedValue(undefined),
  markGoatCheckoutRecordOpen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth", () => ({ currentGoatUser: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({
  assertGoatCheckoutEnabled: vi.fn(),
  getGoatAppUrl: vi.fn(() => "https://goat.test"),
  getGoatStripe: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

describe("Goat billing actions", () => {
  const checkoutCreate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(currentGoatUser).mockResolvedValue({
      role: "member",
      workspace: { id: "goat_ws_1", name: "Acme" },
      user: { workosUserId: "user_1" },
      authUser: { email: "member@example.com" },
    } as Awaited<ReturnType<typeof currentGoatUser>>);
    vi.mocked(loadGoatBillingOverview).mockResolvedValue({
      billing: { stripeCustomerId: "cus_goat_1" },
    } as unknown as Awaited<ReturnType<typeof loadGoatBillingOverview>>);
    checkoutCreate.mockResolvedValue({
      id: "cs_test_1",
      url: "https://checkout.stripe.test/session",
    });
    vi.mocked(getGoatStripe).mockReturnValue({
      checkout: { sessions: { create: checkoutCreate } },
    } as never);
  });

  it("creates a payment-mode top-up Checkout for any member, saving the card", async () => {
    await expect(createGoatCreditTopUpAction(1_000)).rejects.toThrow("NEXT_REDIRECT");

    expect(createGoatPendingCheckoutRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "goat_ws_1",
        userWorkosId: "user_1",
        amountCents: 1_000,
      }),
    );
    const [params] = checkoutCreate.mock.calls[0] as [
      {
        mode: string;
        allow_promotion_codes: boolean;
        payment_intent_data: { setup_future_usage: string };
        line_items: Array<{ price_data: { currency: string; unit_amount: number } }>;
        metadata: Record<string, string>;
      },
    ];
    expect(params.mode).toBe("payment");
    expect(params.allow_promotion_codes).toBe(true);
    // The saved card is what auto-refill charges off-session later.
    expect(params.payment_intent_data).toEqual({ setup_future_usage: "off_session" });
    expect(params.line_items[0]?.price_data).toMatchObject({
      currency: "usd",
      unit_amount: 1_000,
    });
    expect(params.metadata.billingProduct).toBe("goat_topup");
    expect(params.metadata.goatWorkspaceId).toBe("goat_ws_1");
    expect(params.metadata.amountCents).toBe("1000");
    expect(markGoatCheckoutRecordOpen).toHaveBeenCalledWith(
      expect.objectContaining({ stripeCheckoutSessionId: "cs_test_1" }),
    );
    expect(redirect).toHaveBeenCalledWith("https://checkout.stripe.test/session");
  });

  it("rejects top-up amounts outside the allowed range", async () => {
    await expect(createGoatCreditTopUpAction(100)).resolves.toMatchObject({ ok: false });
    await expect(createGoatCreditTopUpAction(1_000_000)).resolves.toMatchObject({ ok: false });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("saves auto-refill config when a payment method exists", async () => {
    vi.mocked(setGoatAutoRefillConfig).mockResolvedValue({ enabled: true, amountCents: 2_000 });

    await expect(setGoatAutoRefillAction({ enabled: true, amountCents: 2_000 })).resolves.toEqual({
      ok: true,
    });
    expect(setGoatAutoRefillConfig).toHaveBeenCalledWith({
      workspaceId: "goat_ws_1",
      enabled: true,
      amountCents: 2_000,
    });
  });

  it("refuses to enable auto-refill before a card is saved", async () => {
    vi.mocked(setGoatAutoRefillConfig).mockResolvedValue(null);

    await expect(
      setGoatAutoRefillAction({ enabled: true, amountCents: 2_000 }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("rejects auto-refill amounts outside the allowed range", async () => {
    await expect(
      setGoatAutoRefillAction({ enabled: true, amountCents: 100 }),
    ).resolves.toMatchObject({ ok: false });
    expect(setGoatAutoRefillConfig).not.toHaveBeenCalled();
  });
});
