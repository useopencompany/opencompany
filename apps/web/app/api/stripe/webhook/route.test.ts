import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";
import { captureServerEvent } from "@opencompany/analytics/server";
import {
  applyGoatStripeInvoicePaymentState,
  applyGoatStripeSubscriptionProjection,
  findGoatWorkspaceIdForStripeSubscription,
  releasePendingForWorkspace,
  setGoatAutoRefillPaymentMethod,
  settleGoatAutoRefill,
} from "@opencompany/db/goat-billing";
import {
  fulfillGoatTopUpCheckoutSession,
  markGoatCheckoutRecordFailed,
  recordGoatAutoRefillCredit,
} from "@opencompany/db/goat-credits";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fulfillCheckoutSession } from "@/lib/billing/legacy-credits";
import { getGoatStripe, getGoatStripeWebhookSecret } from "@/lib/billing/stripe";
import { POST } from "./route";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@opencompany/analytics/goat/server", () => ({
  captureGoatServerEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@opencompany/db/goat-billing", () => ({
  applyGoatStripeInvoicePaymentState: vi.fn().mockResolvedValue(true),
  applyGoatStripeSubscriptionProjection: vi.fn().mockResolvedValue({
    applied: true,
    planChanged: true,
    plan: "pro",
    cancellationScheduled: false,
  }),
  findGoatWorkspaceIdForStripeSubscription: vi.fn().mockResolvedValue(null),
  GOAT_PRO_STRIPE_PRODUCT_KEY: "goat_pro",
  releasePendingForWorkspace: vi.fn().mockResolvedValue(0),
  setGoatAutoRefillPaymentMethod: vi.fn().mockResolvedValue(undefined),
  settleGoatAutoRefill: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@opencompany/db/goat-credits", () => ({
  fulfillGoatTopUpCheckoutSession: vi.fn(),
  goatUsdMicrosToCents: (micros: number) => Math.round(micros / 10_000),
  markGoatCheckoutRecordFailed: vi.fn(),
  recordGoatAutoRefillCredit: vi.fn().mockResolvedValue({
    ok: true,
    ledgerId: 1,
    balanceUsdMicros: 25_000_000,
  }),
}));

vi.mock("@/lib/billing/legacy-credits", () => ({
  fulfillCheckoutSession: vi.fn(),
}));

vi.mock("@/lib/billing/stripe", () => ({
  getGoatStripe: vi.fn(),
  getGoatStripeWebhookSecret: vi.fn(),
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

const captureGoatServerEventMock = vi.mocked(captureGoatServerEvent);
const captureServerEventMock = vi.mocked(captureServerEvent);
const applyGoatStripeInvoicePaymentStateMock = vi.mocked(applyGoatStripeInvoicePaymentState);
const applyGoatStripeSubscriptionProjectionMock = vi.mocked(applyGoatStripeSubscriptionProjection);
const findGoatWorkspaceIdForStripeSubscriptionMock = vi.mocked(
  findGoatWorkspaceIdForStripeSubscription,
);
const fulfillCheckoutSessionMock = vi.mocked(fulfillCheckoutSession);
const fulfillGoatTopUpCheckoutSessionMock = vi.mocked(fulfillGoatTopUpCheckoutSession);
const markGoatCheckoutRecordFailedMock = vi.mocked(markGoatCheckoutRecordFailed);
const recordGoatAutoRefillCreditMock = vi.mocked(recordGoatAutoRefillCredit);
const releasePendingForWorkspaceMock = vi.mocked(releasePendingForWorkspace);
const setGoatAutoRefillPaymentMethodMock = vi.mocked(setGoatAutoRefillPaymentMethod);
const settleGoatAutoRefillMock = vi.mocked(settleGoatAutoRefill);
const getGoatStripeMock = vi.mocked(getGoatStripe);
const getGoatStripeWebhookSecretMock = vi.mocked(getGoatStripeWebhookSecret);

function request(signature: string | null) {
  return new Request("https://app.example.com/api/stripe/webhook", {
    method: "POST",
    headers: signature ? { "stripe-signature": signature } : {},
    body: JSON.stringify({ id: "evt_123" }),
  });
}

function stripeWithEvent(event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    webhooks: { constructEvent: vi.fn(() => event) },
    ...extra,
  } as never;
}

describe("Stripe webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGoatStripeWebhookSecretMock.mockReturnValue("whsec_123");
    releasePendingForWorkspaceMock.mockResolvedValue(0);
  });

  it("rejects requests without a Stripe signature", async () => {
    const response = await POST(request(null));

    expect(response.status).toBe(400);
    expect(fulfillCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("rejects invalid webhook signatures", async () => {
    getGoatStripeMock.mockReturnValue({
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
    getGoatStripeMock.mockReturnValue(
      stripeWithEvent({
        id: "evt_123",
        type: "checkout.session.completed",
        data: { object: session },
      }),
    );

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
    getGoatStripeMock.mockReturnValue(
      stripeWithEvent({
        id: "evt_123",
        type: "checkout.session.completed",
        data: { object: session },
      }),
    );

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(fulfillCheckoutSessionMock).toHaveBeenCalledWith(session, { eventId: "evt_123" });
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });

  it("fulfills a Goat top-up, releases paused ingestion, and saves the card", async () => {
    const session = {
      id: "cs_goat_delayed",
      mode: "payment",
      payment_status: "paid",
      payment_intent: "pi_topup_1",
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
    const retrievePaymentIntent = vi
      .fn()
      .mockResolvedValue({ id: "pi_topup_1", payment_method: "pm_card_1" });
    getGoatStripeMock.mockReturnValue(
      stripeWithEvent(
        {
          id: "evt_goat_delayed",
          type: "checkout.session.async_payment_succeeded",
          data: { object: session },
        },
        { paymentIntents: { retrieve: retrievePaymentIntent } },
      ),
    );

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(fulfillGoatTopUpCheckoutSessionMock).toHaveBeenCalledWith(session, {
      eventId: "evt_goat_delayed",
    });
    // The release/PM-capture/analytics chain runs inside after(); wait for the
    // async callback to flush.
    await vi.waitFor(() => {
      expect(releasePendingForWorkspaceMock).toHaveBeenCalledWith("goat_ws_1");
      expect(setGoatAutoRefillPaymentMethodMock).toHaveBeenCalledWith({
        workspaceId: "goat_ws_1",
        paymentMethodId: "pm_card_1",
      });
      expect(captureServerEventMock).toHaveBeenCalledWith(
        "goat_billing_topup_completed",
        "goat_ws_1",
        expect.objectContaining({
          checkout_record_id: "gcs_123",
          amount_cents: 1_000,
          amount_usd: 10,
        }),
      );
      expect(captureGoatServerEventMock).toHaveBeenCalledWith("billing_topup_completed", "user_1", {
        workspace_id: "goat_ws_1",
        topup_type: "manual",
        amount_cents: 1_000,
        amount_usd: 10,
        balance_cents: 1_500,
      });
    });
  });

  it("marks the Goat checkout record failed after a delayed payment fails", async () => {
    getGoatStripeMock.mockReturnValue(
      stripeWithEvent({
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
      }),
    );

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(markGoatCheckoutRecordFailedMock).toHaveBeenCalledWith({
      id: "gcs_123",
      error: "Stripe reported that the delayed Checkout payment failed.",
    });
    expect(fulfillGoatTopUpCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it("waits for the subscription webhook before granting Pro", async () => {
    getGoatStripeMock.mockReturnValue(
      stripeWithEvent({
        id: "evt_goat_sub",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_goat_sub",
            mode: "subscription",
            metadata: { billingProduct: "goat_pro", goatWorkspaceId: "goat_ws_1" },
          },
        },
      }),
    );
    const checkoutResponse = await POST(request("sig_ok"));
    expect(checkoutResponse.status).toBe(200);
    expect(fulfillCheckoutSessionMock).not.toHaveBeenCalled();

    expect(applyGoatStripeSubscriptionProjectionMock).not.toHaveBeenCalled();

    getGoatStripeMock.mockReturnValue(
      stripeWithEvent({
        id: "evt_goat_sub_2",
        type: "customer.subscription.updated",
        created: 1_786_000_000,
        data: {
          object: {
            id: "sub_goat_1",
            customer: "cus_goat_1",
            status: "active",
            cancel_at_period_end: false,
            metadata: { billingProduct: "goat_pro", goatWorkspaceId: "goat_ws_1" },
            items: {
              data: [
                {
                  id: "si_goat_1",
                  price: { id: "price_goat_1" },
                  quantity: 3,
                  current_period_start: 1_786_000_000,
                  current_period_end: 1_788_000_000,
                },
              ],
            },
          },
        },
      }),
    );
    const subscriptionResponse = await POST(request("sig_ok"));
    expect(subscriptionResponse.status).toBe(200);
    expect(applyGoatStripeSubscriptionProjectionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "goat_ws_1",
        subscriptionId: "sub_goat_1",
        status: "active",
        priceId: "price_goat_1",
        currentPeriodStart: new Date(1_786_000_000 * 1_000),
        currentPeriodEnd: new Date(1_788_000_000 * 1_000),
        seatQuantity: 3,
      }),
    );
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "goat_billing_plan_changed",
      "goat_ws_1",
      expect.objectContaining({ plan: "pro" }),
    );
  });

  it("does not grant Pro from an unrelated Stripe subscription", async () => {
    getGoatStripeMock.mockReturnValue(
      stripeWithEvent({
        id: "evt_other_sub",
        type: "customer.subscription.updated",
        created: 1_786_000_000,
        data: {
          object: {
            id: "sub_other_1",
            customer: "cus_other_1",
            status: "active",
            cancel_at_period_end: false,
            metadata: { billingProduct: "other_product", goatWorkspaceId: "goat_ws_1" },
            items: { data: [] },
          },
        },
      }),
    );

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(applyGoatStripeSubscriptionProjectionMock).not.toHaveBeenCalled();
  });

  it("marks a failed Pro invoice for attention", async () => {
    findGoatWorkspaceIdForStripeSubscriptionMock.mockResolvedValueOnce("goat_ws_1");
    getGoatStripeMock.mockReturnValue(
      stripeWithEvent({
        id: "evt_invoice_failed",
        type: "invoice.payment_failed",
        created: 1_786_000_000,
        data: {
          object: {
            id: "in_goat_1",
            parent: { subscription_details: { subscription: "sub_goat_1" } },
          },
        },
      }),
    );

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(applyGoatStripeInvoicePaymentStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: "sub_goat_1",
        needsAttention: true,
      }),
    );
    expect(captureServerEventMock).toHaveBeenCalledWith(
      "goat_billing_payment_failed",
      "goat_ws_1",
      expect.objectContaining({ subscription_id: "sub_goat_1" }),
    );
  });

  it("credits a Goat auto-refill PaymentIntent and releases paused ingestion", async () => {
    getGoatStripeMock.mockReturnValue(
      stripeWithEvent({
        id: "evt_pi_goat",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_goat_1",
            metadata: {
              billingProduct: "goat_auto_refill",
              goatWorkspaceId: "goat_ws_1",
              amountCents: "2000",
            },
          },
        },
      }),
    );

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(recordGoatAutoRefillCreditMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_1",
      amountCents: 2_000,
      paymentIntentId: "pi_goat_1",
    });
    expect(captureGoatServerEventMock).toHaveBeenCalledWith(
      "billing_topup_completed",
      "goat_ws_1",
      {
        workspace_id: "goat_ws_1",
        topup_type: "auto_refill",
        amount_cents: 2_000,
        amount_usd: 20,
        balance_cents: 2_500,
      },
    );
    expect(releasePendingForWorkspaceMock).toHaveBeenCalledWith("goat_ws_1");
  });

  it("does not capture a duplicate auto-refill credit", async () => {
    recordGoatAutoRefillCreditMock.mockResolvedValueOnce({
      ok: false,
      reason: "duplicate",
    });
    getGoatStripeMock.mockReturnValue(
      stripeWithEvent({
        id: "evt_pi_goat_replay",
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_goat_1",
            metadata: {
              billingProduct: "goat_auto_refill",
              goatWorkspaceId: "goat_ws_1",
              amountCents: "2000",
            },
          },
        },
      }),
    );

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(captureGoatServerEventMock).not.toHaveBeenCalled();
  });

  it("disables Goat auto-refill after a failed off-session charge", async () => {
    getGoatStripeMock.mockReturnValue(
      stripeWithEvent({
        id: "evt_pi_goat_failed",
        type: "payment_intent.payment_failed",
        data: {
          object: {
            id: "pi_goat_2",
            last_payment_error: { message: "Your card was declined." },
            metadata: {
              billingProduct: "goat_auto_refill",
              goatWorkspaceId: "goat_ws_1",
              amountCents: "2000",
            },
          },
        },
      }),
    );

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(settleGoatAutoRefillMock).toHaveBeenCalledWith({
      workspaceId: "goat_ws_1",
      disable: true,
      error: "Your card was declined.",
    });
    expect(recordGoatAutoRefillCreditMock).not.toHaveBeenCalled();
  });

  it("routes non-goat payment intents to the legacy auto-refill handler untouched", async () => {
    getGoatStripeMock.mockReturnValue(
      stripeWithEvent({
        id: "evt_123",
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_web_1", metadata: {} } },
      }),
    );

    const response = await POST(request("sig_ok"));

    expect(response.status).toBe(200);
    expect(recordGoatAutoRefillCreditMock).not.toHaveBeenCalled();
    expect(fulfillCheckoutSessionMock).not.toHaveBeenCalled();
    expect(captureServerEventMock).not.toHaveBeenCalled();
  });
});
