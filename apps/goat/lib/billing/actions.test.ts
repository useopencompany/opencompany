import { loadGoatBillingOverview } from "@opencompany/db/goat-billing";
import {
  createGoatPendingCheckoutRecord,
  markGoatCheckoutRecordOpen,
} from "@opencompany/db/goat-credits";
import { countGoatWorkspaceMembers } from "@opencompany/db/goat-workspaces";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { getGoatProPriceId, getGoatStripe } from "@/lib/billing/stripe";
import { createGoatCreditTopUpAction, createGoatProCheckoutAction } from "./actions";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@opencompany/db/goat-billing", () => ({
  GOAT_PRO_SEAT_MONTHLY_PRICE_USD_CENTS: 1_700,
  loadGoatBillingOverview: vi.fn(),
  setGoatStripeCustomerId: vi.fn(),
}));

vi.mock("@opencompany/db/goat-credits", () => ({
  createGoatPendingCheckoutRecord: vi.fn().mockResolvedValue(undefined),
  markGoatCheckoutRecordFailed: vi.fn().mockResolvedValue(undefined),
  markGoatCheckoutRecordOpen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@opencompany/db/goat-workspaces", () => ({
  countGoatWorkspaceMembers: vi.fn().mockResolvedValue(1),
}));

vi.mock("@/lib/auth", () => ({ currentGoatUser: vi.fn() }));
vi.mock("@/lib/billing/stripe", () => ({
  assertGoatCheckoutEnabled: vi.fn(),
  getGoatAppUrl: vi.fn(() => "https://goat.test"),
  getGoatProPriceId: vi.fn(() => "price_goat_pro"),
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
      role: "admin",
      workspace: { id: "goat_ws_1", name: "Acme" },
      user: { workosUserId: "user_1" },
      authUser: { email: "admin@example.com" },
    } as Awaited<ReturnType<typeof currentGoatUser>>);
    vi.mocked(loadGoatBillingOverview).mockResolvedValue({
      plan: "free",
      billing: { stripeCustomerId: "cus_goat_1" },
    } as Awaited<ReturnType<typeof loadGoatBillingOverview>>);
    vi.mocked(countGoatWorkspaceMembers).mockResolvedValue(3);
    checkoutCreate.mockResolvedValue({
      id: "cs_test_1",
      url: "https://checkout.stripe.test/session",
    });
    vi.mocked(getGoatStripe).mockReturnValue({
      checkout: { sessions: { create: checkoutCreate } },
    } as never);
  });

  it("creates tax-aware seat-priced Checkout with quantity = member count", async () => {
    await expect(createGoatProCheckoutAction()).rejects.toThrow("NEXT_REDIRECT");

    expect(getGoatProPriceId).toHaveBeenCalled();
    const [params] = checkoutCreate.mock.calls[0] as [
      {
        line_items: Array<{ price: string; quantity: number }>;
        allow_promotion_codes: boolean;
        automatic_tax: { enabled: boolean };
        payment_method_types?: unknown;
        subscription_data: { metadata: Record<string, string> };
      },
    ];
    expect(params.line_items).toEqual([{ price: "price_goat_pro", quantity: 3 }]);
    expect(params.allow_promotion_codes).toBe(true);
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.payment_method_types).toBeUndefined();
    expect(params.subscription_data.metadata.goatWorkspaceId).toBe("goat_ws_1");
    expect(redirect).toHaveBeenCalledWith("https://checkout.stripe.test/session");
  });

  it("only reuses Pro Checkout idempotency keys for identical parameters", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_784_190_000_000);

    try {
      await expect(createGoatProCheckoutAction()).rejects.toThrow("NEXT_REDIRECT");
      await expect(createGoatProCheckoutAction()).rejects.toThrow("NEXT_REDIRECT");
      vi.mocked(countGoatWorkspaceMembers).mockResolvedValue(4);
      await expect(createGoatProCheckoutAction()).rejects.toThrow("NEXT_REDIRECT");
    } finally {
      now.mockRestore();
    }

    const keys = checkoutCreate.mock.calls.map(
      ([, options]) => (options as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(/^goat-pro-v2-goat_ws_1-\d+-[a-f0-9]{16}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toMatch(/^goat-pro-v2-goat_ws_1-\d+-[a-f0-9]{16}$/);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("rejects billing changes from non-admin members", async () => {
    vi.mocked(currentGoatUser).mockResolvedValue({
      role: "member",
    } as Awaited<ReturnType<typeof currentGoatUser>>);

    await expect(createGoatProCheckoutAction()).resolves.toEqual({
      ok: false,
      error: "Only workspace admins can change the plan.",
    });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });

  it("creates a payment-mode top-up Checkout with goat_topup metadata", async () => {
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
        line_items: Array<{ price_data: { currency: string; unit_amount: number } }>;
        metadata: Record<string, string>;
      },
    ];
    expect(params.mode).toBe("payment");
    expect(params.allow_promotion_codes).toBe(true);
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

  it("rejects top-ups from non-admin members", async () => {
    vi.mocked(currentGoatUser).mockResolvedValue({
      role: "member",
    } as Awaited<ReturnType<typeof currentGoatUser>>);

    await expect(createGoatCreditTopUpAction(1_000)).resolves.toEqual({
      ok: false,
      error: "Only workspace admins can add credits.",
    });
    expect(checkoutCreate).not.toHaveBeenCalled();
  });
});
