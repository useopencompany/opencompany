import { captureServerEvent } from "@opencompany/analytics/server";
import {
  applyGoatStripeInvoicePaymentState,
  applyGoatStripeSubscriptionProjection,
  findGoatWorkspaceIdForStripeSubscription,
} from "@opencompany/db/goat-billing";
import {
  fulfillGoatTopUpCheckoutSession,
  markGoatCheckoutRecordFailed,
} from "@opencompany/db/goat-credits";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fulfillCheckoutSession } from "@/lib/billing/service";
import { getStripe, getStripeWebhookSecret } from "@/lib/billing/stripe";
import { POST } from "./route";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@opencompany/db/goat-billing", () => ({
  GOAT_PRO_SEAT_MONTHLY_PRICE_USD_CENTS: 1_700,
  applyGoatStripeInvoicePaymentState: vi.fn(),
  applyGoatStripeSubscriptionProjection: vi.fn(),
  findGoatWorkspaceIdForStripeSubscription: vi.fn(),
}));

vi.mock("@opencompany/db/goat-credits", () => ({
  fulfillGoatTopUpCheckoutSession: vi.fn(),
  markGoatCheckoutRecordFailed: vi.fn(),
}));

vi.mock("@/lib/billing/service", () => ({
  fulfillCheckoutSession: vi.fn(),
}));

vi.mock("@/lib/billing/stripe", () => ({
  getStripe: vi.fn(),
  getStripeWebhookSecret: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (callback: () => unknown) => {
      void callback();
    },
  };
});

const captureServerEventMock = vi.mocked(captureServerEvent);
const fulfillCheckoutSessionMock = vi.mocked(fulfillCheckoutSession);
const fulfillGoatTopUpCheckoutSessionMock = vi.mocked(fulfillGoatTopUpCheckoutSession);
const markGoatCheckoutRecordFailedMock = vi.mocked(markGoatCheckoutRecordFailed);
const getStripeMock = vi.mocked(getStripe);
const getStripeWebhookSecretMock = vi.mocked(getStripeWebhookSecret);
const applyGoatStripeInvoicePaymentStateMock = vi.mocked(applyGoatStripeInvoicePaymentState);
const applyGoatStripeSubscriptionProjectionMock = vi.mocked(applyGoatStripeSubscriptionProjection);
const findGoatWorkspaceIdForStripeSubscriptionMock = vi.mocked(
  findGoatWorkspaceIdForStripeSubscription,
);

function request(signature: string | null) {
  return new Request("https://app.example.com/api/stripe/webhook", {
    method: "POST",
    headers: signature ? { "stripe-signature": signature } : {},
    body: JSON.stringify({ id: "evt_123" }),
  });
}

describe("Stripe webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStripeWebhookSecretMock.mockReturnValue("whsec_123");
    applyGoatStripeSubscriptionProjectionMock.mockResolvedValue({
      applied: true,
      planChanged: false,
      plan: "pro",
      cancellationScheduled: false,
    });
    applyGoatStripeInvoicePaymentStateMock.mockResolvedValue(true);
  });

  it("rejects requests without a Stripe signature", async () => {
    const response = await POST(request(null));

    expect(response.status).toBe(400);
    expect(fulfillCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("rejects invalid webhook signatures", async () => {
    getStripeMock.mockReturnValue({
      webhooks: {
        constructEvent: vi.fn(() => {
          throw new Error("signature mismatch");
        }),
      },
    } as never);

    const response = await POST(request("sig_bad"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "signature mismatch" });
  });

  it("fulfills completed Checkout Sessions", async () => {
    const session = { id: "cs_test_123", payment_status: "paid", metadata: {} };
    fulfillCheckoutSessionMock.mockResolvedValue({
      ok: true,
      checkoutRecordId: "chk_123",
      workspaceId: "wks_123",
      userId: "usr_123",
      amountCents: 2500,
      balanceCents: 5000,
      ledgerId: 22,
    });
    getStripeMock.mockReturnValue({
      webhooks: {
        constructEvent: vi.fn(() => ({
          id: "evt_123",
          type: "checkout.session.completed",
          data: { object: session },
        })),
      },
    } as never);

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(fulfillCheckoutSessionMock).toHaveBeenCalledWith(session, { eventId: "evt_123" });
    expect(captureServerEventMock).toHaveBeenCalledWith("credit_top_up_completed", "usr_123", {
      user_id: "usr_123",
      workspace_id: "wks_123",
      checkout_record_id: "chk_123",
      ledger_id: 22,
      amount_cents: 2500,
      balance_cents: 5000,
    });
  });

  it("does not capture analytics for completed Checkout Sessions that are not fulfilled", async () => {
    const session = { id: "cs_test_123", payment_status: "paid", metadata: {} };
    fulfillCheckoutSessionMock.mockResolvedValue({
      ok: false,
      reason: "already_fulfilled_or_mismatch",
    });
    getStripeMock.mockReturnValue({
      webhooks: {
        constructEvent: vi.fn(() => ({
          id: "evt_123",
          type: "checkout.session.completed",
          data: { object: session },
        })),
      },
    } as never);

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(fulfillCheckoutSessionMock).toHaveBeenCalledWith(session, { eventId: "evt_123" });
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("fulfills a Goat top-up after a delayed payment succeeds", async () => {
    const session = {
      id: "cs_goat_delayed",
      mode: "payment",
      payment_status: "paid",
      metadata: {
        billingProduct: "goat_topup",
        checkoutRecordId: "gcs_123",
        goatWorkspaceId: "goat_ws_1",
        userWorkosId: "user_1",
        amountCents: "1000",
      },
    };
    fulfillGoatTopUpCheckoutSessionMock.mockResolvedValue({
      ok: true,
      checkoutRecordId: "gcs_123",
      amountCents: 1_000,
      balanceCents: 1_500,
    });
    getStripeMock.mockReturnValue({
      webhooks: {
        constructEvent: vi.fn(() => ({
          id: "evt_goat_delayed",
          type: "checkout.session.async_payment_succeeded",
          data: { object: session },
        })),
      },
    } as never);

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(fulfillGoatTopUpCheckoutSessionMock).toHaveBeenCalledWith(session, {
      eventId: "evt_goat_delayed",
    });
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "goat_billing_topup_completed",
      "goat_ws_1",
      expect.objectContaining({ checkout_record_id: "gcs_123", amount_cents: 1_000 }),
    );
  });

  it("marks the Goat checkout record failed after a delayed payment fails", async () => {
    getStripeMock.mockReturnValue({
      webhooks: {
        constructEvent: vi.fn(() => ({
          id: "evt_goat_failed",
          type: "checkout.session.async_payment_failed",
          data: {
            object: {
              id: "cs_goat_delayed",
              mode: "payment",
              payment_status: "unpaid",
              metadata: {
                billingProduct: "goat_topup",
                checkoutRecordId: "gcs_123",
              },
            },
          },
        })),
      },
    } as never);

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(markGoatCheckoutRecordFailedMock).toHaveBeenCalledWith({
      id: "gcs_123",
      error: "Stripe reported that the delayed Checkout payment failed.",
    });
    expect(fulfillGoatTopUpCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("projects Goat subscription events without entering the credit checkout flow", async () => {
    getStripeMock.mockReturnValue({
      webhooks: {
        constructEvent: vi.fn(() => ({
          id: "evt_goat_1",
          type: "customer.subscription.updated",
          created: 1_783_929_600,
          data: {
            object: {
              id: "sub_goat_1",
              customer: "cus_goat_1",
              status: "active",
              cancel_at_period_end: false,
              metadata: { billingProduct: "goat", goatWorkspaceId: "goat_ws_1" },
              items: {
                data: [
                  {
                    id: "si_goat_1",
                    quantity: 3,
                    current_period_end: 1_786_608_000,
                    price: { id: "price_goat_pro" },
                  },
                ],
              },
            },
          },
        })),
      },
    } as never);

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(applyGoatStripeSubscriptionProjectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "goat_ws_1",
        subscriptionId: "sub_goat_1",
        status: "active",
      }),
    );
    expect(fulfillCheckoutSessionMock).not.toHaveBeenCalled();
    expect(findGoatWorkspaceIdForStripeSubscriptionMock).not.toHaveBeenCalled();
  });

  it("resolves an existing Goat subscription when Stripe metadata is absent", async () => {
    findGoatWorkspaceIdForStripeSubscriptionMock.mockResolvedValue("goat_ws_2");
    getStripeMock.mockReturnValue({
      webhooks: {
        constructEvent: vi.fn(() => ({
          id: "evt_goat_2",
          type: "customer.subscription.updated",
          created: 1_783_929_600,
          data: {
            object: {
              id: "sub_goat_2",
              customer: "cus_goat_2",
              status: "past_due",
              cancel_at_period_end: false,
              metadata: {},
              items: { data: [] },
            },
          },
        })),
      },
    } as never);

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(findGoatWorkspaceIdForStripeSubscriptionMock).toHaveBeenCalledWith("sub_goat_2");
    expect(applyGoatStripeSubscriptionProjectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "goat_ws_2", subscriptionId: "sub_goat_2" }),
    );
  });

  it.each([
    ["invoice.paid", false],
    ["invoice.payment_failed", true],
  ] as const)("projects Goat %s payment state", async (eventType, needsAttention) => {
    findGoatWorkspaceIdForStripeSubscriptionMock.mockResolvedValue("goat_ws_3");
    getStripeMock.mockReturnValue({
      webhooks: {
        constructEvent: vi.fn(() => ({
          id: `evt_${eventType}`,
          type: eventType,
          created: 1_783_929_600,
          data: {
            object: {
              id: "in_goat_1",
              parent: { subscription_details: { subscription: "sub_goat_3" } },
            },
          },
        })),
      },
    } as never);

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(findGoatWorkspaceIdForStripeSubscriptionMock).toHaveBeenCalledWith("sub_goat_3");
    expect(applyGoatStripeInvoicePaymentStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType,
        subscriptionId: "sub_goat_3",
        needsAttention,
      }),
    );
  });

  it("ignores unrelated event types", async () => {
    getStripeMock.mockReturnValue({
      webhooks: {
        constructEvent: vi.fn(() => ({
          id: "evt_123",
          type: "payment_intent.succeeded",
          data: { object: {} },
        })),
      },
    } as never);

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(fulfillCheckoutSessionMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });
});
