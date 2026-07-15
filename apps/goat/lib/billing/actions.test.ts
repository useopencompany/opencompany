import { loadGoatBillingOverview } from "@opencompany/db/goat-billing";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentGoatUser } from "@/lib/auth";
import { getGoatProPriceId, getGoatStripe } from "@/lib/billing/stripe";
import { createGoatProCheckoutAction } from "./actions";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@opencompany/db/goat-billing", () => ({
  GOAT_PRO_MONTHLY_PRICE_USD_CENTS: 9_900,
  loadGoatBillingOverview: vi.fn(),
  setGoatStripeCustomerId: vi.fn(),
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
    checkoutCreate.mockResolvedValue({ url: "https://checkout.stripe.test/session" });
    vi.mocked(getGoatStripe).mockReturnValue({
      checkout: { sessions: { create: checkoutCreate } },
    } as never);
  });

  it("creates tax-aware flat-price Checkout without fixed payment methods", async () => {
    await expect(createGoatProCheckoutAction()).rejects.toThrow("NEXT_REDIRECT");

    expect(getGoatProPriceId).toHaveBeenCalled();
    const [params] = checkoutCreate.mock.calls[0] as [
      {
        line_items: Array<{ price: string; quantity: number }>;
        automatic_tax: { enabled: boolean };
        payment_method_types?: unknown;
        subscription_data: { metadata: Record<string, string> };
      },
    ];
    expect(params.line_items).toEqual([{ price: "price_goat_pro", quantity: 1 }]);
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.payment_method_types).toBeUndefined();
    expect(params.subscription_data.metadata.goatWorkspaceId).toBe("goat_ws_1");
    expect(redirect).toHaveBeenCalledWith("https://checkout.stripe.test/session");
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
});
