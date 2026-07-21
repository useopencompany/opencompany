import { captureServerEvent } from "@opencompany/analytics/server";
import {
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
import { fulfillCheckoutSession } from "@/lib/billing/service";
import { getStripe, getStripeWebhookSecret } from "@/lib/billing/stripe";
import { POST } from "./route";

vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@opencompany/db/goat-billing", () => ({
  releasePendingForWorkspace: vi.fn().mockResolvedValue(0),
  setGoatAutoRefillPaymentMethod: vi.fn().mockResolvedValue(undefined),
  settleGoatAutoRefill: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@opencompany/db/goat-credits", () => ({
  fulfillGoatTopUpCheckoutSession: vi.fn(),
  markGoatCheckoutRecordFailed: vi.fn(),
  recordGoatAutoRefillCredit: vi.fn().mockResolvedValue({ ok: true }),
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
const recordGoatAutoRefillCreditMock = vi.mocked(recordGoatAutoRefillCredit);
const releasePendingForWorkspaceMock = vi.mocked(releasePendingForWorkspace);
const setGoatAutoRefillPaymentMethodMock = vi.mocked(setGoatAutoRefillPaymentMethod);
const settleGoatAutoRefillMock = vi.mocked(settleGoatAutoRefill);
const getStripeMock = vi.mocked(getStripe);
const getStripeWebhookSecretMock = vi.mocked(getStripeWebhookSecret);

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
    getStripeWebhookSecretMock.mockReturnValue("whsec_123");
    releasePendingForWorkspaceMock.mockResolvedValue(0);
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
    getStripeMock.mockReturnValue(
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
    getStripeMock.mockReturnValue(
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
    getStripeMock.mockReturnValue(
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
        expect.objectContaining({ checkout_record_id: "gcs_123", amount_cents: 1_000 }),
      );
    });
  });

  it("marks the Goat checkout record failed after a delayed payment fails", async () => {
    getStripeMock.mockReturnValue(
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

  it("ignores straggler legacy Goat subscription checkouts and lifecycle events", async () => {
    getStripeMock.mockReturnValue(
      stripeWithEvent({
        id: "evt_goat_sub",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_goat_sub",
            mode: "subscription",
            metadata: { billingProduct: "goat", goatWorkspaceId: "goat_ws_1" },
          },
        },
      }),
    );
    const checkoutResponse = await POST(request("sig_ok"));
    expect(checkoutResponse.status).toBe(200);
    expect(fulfillCheckoutSessionMock).not.toHaveBeenCalled();

    getStripeMock.mockReturnValue(
      stripeWithEvent({
        id: "evt_goat_sub_2",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_goat_1", metadata: { billingProduct: "goat" } } },
      }),
    );
    const subscriptionResponse = await POST(request("sig_ok"));
    expect(subscriptionResponse.status).toBe(200);
  });

  it("credits a Goat auto-refill PaymentIntent and releases paused ingestion", async () => {
    getStripeMock.mockReturnValue(
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
    expect(releasePendingForWorkspaceMock).toHaveBeenCalledWith("goat_ws_1");
  });

  it("disables Goat auto-refill after a failed off-session charge", async () => {
    getStripeMock.mockReturnValue(
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

  it("routes non-goat payment intents to the web auto-refill handler untouched", async () => {
    getStripeMock.mockReturnValue(
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
