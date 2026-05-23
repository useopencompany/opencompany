import { captureException } from "@opencompany/observability";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentWorkspace } from "@/lib/auth";
import {
  createPendingCheckoutRecord,
  markCheckoutRecordFailed,
  markCheckoutRecordOpen,
  newStripeCheckoutRecordId,
} from "@/lib/billing/service";
import { getAppUrl, getStripe } from "@/lib/billing/stripe";
import { createCreditCheckoutSession } from "./actions";

const redirectMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@opencompany/observability", () => ({
  captureException: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentWorkspace: vi.fn(),
}));

vi.mock("@/lib/billing/stripe", () => ({
  getAppUrl: vi.fn(),
  getStripe: vi.fn(),
}));

vi.mock("@/lib/billing/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/service")>();
  return {
    ...actual,
    createPendingCheckoutRecord: vi.fn(),
    markCheckoutRecordFailed: vi.fn(),
    markCheckoutRecordOpen: vi.fn(),
    newStripeCheckoutRecordId: vi.fn(),
  };
});

const getCurrentWorkspaceMock = vi.mocked(getCurrentWorkspace);
const getStripeMock = vi.mocked(getStripe);
const getAppUrlMock = vi.mocked(getAppUrl);
const createPendingCheckoutRecordMock = vi.mocked(createPendingCheckoutRecord);
const markCheckoutRecordFailedMock = vi.mocked(markCheckoutRecordFailed);
const markCheckoutRecordOpenMock = vi.mocked(markCheckoutRecordOpen);
const newStripeCheckoutRecordIdMock = vi.mocked(newStripeCheckoutRecordId);
const captureExceptionMock = vi.mocked(captureException);

describe("createCreditCheckoutSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redirectMock.mockImplementation((url: string) => {
      throw new Error(`redirect:${url}`);
    });
    newStripeCheckoutRecordIdMock.mockReturnValue("chk_123");
    getAppUrlMock.mockReturnValue("https://app.example.com");
    getCurrentWorkspaceMock.mockResolvedValue({
      authUser: { email: "user@example.com" },
      user: { id: "usr_123" },
      workspace: { id: "wks_123" },
    } as never);
  });

  it("rejects out-of-range top-up amounts", async () => {
    const result = await createCreditCheckoutSession(499);

    expect(result).toEqual({
      ok: false,
      error: "Top-up amount must be between 500 and 100000 cents.",
    });
    expect(getStripeMock).not.toHaveBeenCalled();
    expect(createPendingCheckoutRecordMock).not.toHaveBeenCalled();
  });

  it("creates a Stripe Checkout Session with attribution metadata", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
    getStripeMock.mockReturnValue({ checkout: { sessions: { create } } } as never);

    await expect(createCreditCheckoutSession(2500)).rejects.toThrow(
      "redirect:https://checkout.stripe.com/c/pay/cs_test_123",
    );

    expect(createPendingCheckoutRecordMock).toHaveBeenCalledWith({
      id: "chk_123",
      workspaceId: "wks_123",
      userId: "usr_123",
      amountCents: 2500,
    });
    expect(create).toHaveBeenCalledWith({
      mode: "payment",
      customer_email: "user@example.com",
      success_url: "https://app.example.com/settings?billing=success",
      cancel_url: "https://app.example.com/settings?billing=cancelled",
      metadata: {
        workspaceId: "wks_123",
        userId: "usr_123",
        amountCents: "2500",
        checkoutRecordId: "chk_123",
      },
      payment_intent_data: {
        metadata: {
          workspaceId: "wks_123",
          userId: "usr_123",
          amountCents: "2500",
          checkoutRecordId: "chk_123",
        },
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 2500,
            product_data: { name: "$25 Open Company credits" },
          },
        },
      ],
    });
    expect(markCheckoutRecordOpenMock).toHaveBeenCalledWith({
      id: "chk_123",
      stripeCheckoutSessionId: "cs_test_123",
      metadata: {
        workspaceId: "wks_123",
        userId: "usr_123",
        amountCents: "2500",
        checkoutRecordId: "chk_123",
        stripeCheckoutSessionId: "cs_test_123",
      },
    });
  });

  it("creates a Stripe Checkout Session for a custom top-up amount", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "cs_test_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
    getStripeMock.mockReturnValue({ checkout: { sessions: { create } } } as never);

    await expect(createCreditCheckoutSession(1234)).rejects.toThrow(
      "redirect:https://checkout.stripe.com/c/pay/cs_test_123",
    );

    expect(createPendingCheckoutRecordMock).toHaveBeenCalledWith({
      id: "chk_123",
      workspaceId: "wks_123",
      userId: "usr_123",
      amountCents: 1234,
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ amountCents: "1234" }),
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({
              unit_amount: 1234,
              product_data: { name: "$12.34 Open Company credits" },
            }),
          }),
        ],
      }),
    );
  });

  it("marks the pending record failed when Stripe does not return a URL", async () => {
    const create = vi.fn().mockResolvedValue({ id: "cs_test_123", url: null });
    getStripeMock.mockReturnValue({ checkout: { sessions: { create } } } as never);

    const result = await createCreditCheckoutSession(1000);

    expect(result).toEqual({ ok: false, error: "Stripe did not return a Checkout URL." });
    expect(markCheckoutRecordFailedMock).toHaveBeenCalledWith({
      id: "chk_123",
      error: "Stripe did not return a Checkout URL.",
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it("captures checkout failures with workspace context", async () => {
    const error = new Error("Stripe unavailable");
    const create = vi.fn().mockRejectedValue(error);
    getStripeMock.mockReturnValue({ checkout: { sessions: { create } } } as never);

    const result = await createCreditCheckoutSession(1000);

    expect(result).toEqual({ ok: false, error: "Stripe unavailable" });
    expect(markCheckoutRecordFailedMock).toHaveBeenCalledWith({
      id: "chk_123",
      error: "Stripe unavailable",
    });
    expect(captureExceptionMock).toHaveBeenCalledWith(error, {
      event: "opencompany.billing_checkout_failed",
      workspace_id: "wks_123",
      user_id: "usr_123",
      checkout_record_id: "chk_123",
      amount_cents: 1000,
      checkout_stage: "create_stripe_session",
    });
  });

  it("captures checkout configuration failures before creating a record", async () => {
    const error = new Error("STRIPE_SECRET_KEY is required for Stripe billing.");
    getStripeMock.mockImplementation(() => {
      throw error;
    });

    const result = await createCreditCheckoutSession(1000);

    expect(result).toEqual({
      ok: false,
      error: "STRIPE_SECRET_KEY is required for Stripe billing.",
    });
    expect(createPendingCheckoutRecordMock).not.toHaveBeenCalled();
    expect(markCheckoutRecordFailedMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        event: "opencompany.billing_checkout_failed",
        workspace_id: "wks_123",
        user_id: "usr_123",
        amount_cents: 1000,
        checkout_stage: "initialize",
      }),
    );
  });
});
