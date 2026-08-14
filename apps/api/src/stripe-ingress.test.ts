import { completeAutoRefillSetup } from "@opencompany/billing/legacy-auto-refill";
import {
  applyGoatStripeSubscriptionProjection,
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
import { createStripeIngress } from "./stripe-ingress";

vi.mock("@opencompany/analytics/goat/server", () => ({
  captureGoatServerEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@opencompany/analytics/server", () => ({
  captureServerEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@opencompany/billing/legacy-auto-refill", () => ({
  completeAutoRefillSetup: vi.fn(),
  handleAutoRefillPaymentIntentFailed: vi.fn(),
  handleAutoRefillPaymentIntentSucceeded: vi.fn(),
}));
vi.mock("@opencompany/billing/legacy-credits", () => ({ fulfillCheckoutSession: vi.fn() }));
vi.mock("@opencompany/db/goat-billing", () => ({
  GOAT_PRO_STRIPE_PRODUCT_KEY: "goat_pro",
  applyGoatStripeInvoicePaymentState: vi.fn(),
  applyGoatStripeSubscriptionProjection: vi.fn(),
  findGoatWorkspaceIdForStripeSubscription: vi.fn(),
  releasePendingForWorkspace: vi.fn().mockResolvedValue(0),
  setGoatAutoRefillPaymentMethod: vi.fn().mockResolvedValue(undefined),
  settleGoatAutoRefill: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@opencompany/db/goat-credits", () => ({
  fulfillGoatTopUpCheckoutSession: vi.fn(),
  goatUsdMicrosToCents: vi.fn((value: number) => value / 10_000),
  markGoatCheckoutRecordFailed: vi.fn(),
  recordGoatAutoRefillCredit: vi.fn(),
}));

describe("Stripe ingress", () => {
  const db = { marker: "api-db" };
  const constructEvent = vi.fn();
  const stripe = {
    webhooks: { constructEvent },
    paymentIntents: { retrieve: vi.fn() },
  } as never;

  beforeEach(() => vi.clearAllMocks());

  it("requires a signature and verifies the exact raw body", async () => {
    const ingress = createStripeIngress({ db, stripe, webhookSecret: "whsec_test" });
    const missing = await ingress.webhook(
      new Request("https://api.test/webhooks/stripe", { method: "POST", body: "{}" }),
    );
    expect(missing.status).toBe(400);

    const rawBody = '{\n  "id": "evt_raw"\n}';
    constructEvent.mockReturnValue({
      id: "evt_raw",
      type: "customer.created",
      data: { object: {} },
    });
    const accepted = await ingress.webhook(
      new Request("https://api.test/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=raw" },
        body: rawBody,
      }),
    );
    expect(accepted.status).toBe(200);
    expect(constructEvent).toHaveBeenCalledWith(rawBody, "t=1,v1=raw", "whsec_test");

    constructEvent.mockImplementationOnce(() => {
      throw new Error("bad signature");
    });
    const invalid = await ingress.webhook(
      new Request("https://api.test/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "invalid" },
        body: rawBody,
      }),
    );
    expect(invalid.status).toBe(400);
  });

  it("delegates Goat top-up retries to the idempotent ledger fulfillment", async () => {
    constructEvent.mockReturnValue({
      id: "evt_topup_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          mode: "payment",
          payment_status: "paid",
          metadata: { billingProduct: "goat_topup", checkoutRecordId: "goat_chk_1" },
        },
      },
    });
    vi.mocked(fulfillGoatTopUpCheckoutSession).mockResolvedValue({
      ok: false,
      reason: "already_fulfilled_or_missing",
    });
    const ingress = createStripeIngress({ db, stripe, webhookSecret: "whsec_test" });
    const request = () =>
      new Request("https://api.test/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "signature" },
        body: "event-body",
      });

    expect((await ingress.webhook(request())).status).toBe(200);
    expect((await ingress.webhook(request())).status).toBe(200);
    expect(fulfillGoatTopUpCheckoutSession).toHaveBeenCalledTimes(2);
    expect(fulfillGoatTopUpCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cs_1" }),
      { eventId: "evt_topup_1", db },
    );
  });

  it("records delayed top-up failures idempotently in the API database", async () => {
    constructEvent.mockReturnValue({
      id: "evt_failed_1",
      type: "checkout.session.async_payment_failed",
      data: {
        object: {
          id: "cs_failed",
          mode: "payment",
          metadata: { billingProduct: "goat_topup", checkoutRecordId: "goat_chk_failed" },
        },
      },
    });
    const response = await signedRequest(createStripeIngress({ db, stripe, webhookSecret: "x" }));
    expect(response.status).toBe(200);
    expect(markGoatCheckoutRecordFailed).toHaveBeenCalledWith({
      id: "goat_chk_failed",
      error: "Stripe reported that the delayed Checkout payment failed.",
      db,
    });
  });

  it("preserves top-up fulfillment, resume, and saved-card behavior", async () => {
    constructEvent.mockReturnValue({
      id: "evt_topup_success",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_success",
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_1",
          metadata: {
            billingProduct: "goat_topup",
            goatWorkspaceId: "workspace_1",
            userWorkosId: "user_1",
            checkoutRecordId: "goat_chk_1",
          },
        },
      },
    });
    vi.mocked(fulfillGoatTopUpCheckoutSession).mockResolvedValue({
      ok: true,
      checkoutRecordId: "goat_chk_1",
      amountCents: 1_000,
      balanceCents: 2_000,
    });
    (
      stripe as never as { paymentIntents: { retrieve: ReturnType<typeof vi.fn> } }
    ).paymentIntents.retrieve.mockResolvedValue({
      payment_method: "pm_1",
    });
    const response = await signedRequest(createStripeIngress({ db, stripe, webhookSecret: "x" }));
    expect(response.status).toBe(200);
    expect(releasePendingForWorkspace).toHaveBeenCalledWith("workspace_1", expect.any(Date), db);
    expect(setGoatAutoRefillPaymentMethod).toHaveBeenCalledWith(
      { workspaceId: "workspace_1", paymentMethodId: "pm_1" },
      { db },
    );
  });

  it("keeps subscription event ids authoritative in the projection", async () => {
    constructEvent.mockReturnValue({
      id: "evt_subscription_1",
      type: "customer.subscription.updated",
      created: 1_786_636_800,
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "active",
          cancel_at_period_end: false,
          metadata: { billingProduct: "goat_pro", goatWorkspaceId: "workspace_1" },
          items: {
            data: [
              {
                id: "si_1",
                price: { id: "price_1" },
                quantity: 2,
                current_period_start: 1_786_636_800,
                current_period_end: 1_789_315_200,
              },
            ],
          },
        },
      },
    });
    vi.mocked(applyGoatStripeSubscriptionProjection).mockResolvedValue({
      applied: false,
      reason: "duplicate",
    });
    const response = await signedRequest(createStripeIngress({ db, stripe, webhookSecret: "x" }));
    expect(response.status).toBe(200);
    expect(applyGoatStripeSubscriptionProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt_subscription_1",
        workspaceId: "workspace_1",
        subscriptionId: "sub_1",
        subscriptionItemId: "si_1",
        seatQuantity: 2,
      }),
      { db },
    );
  });

  it("keeps auto-refill crediting idempotent and injects the API database", async () => {
    constructEvent.mockReturnValue({
      id: "evt_refill_1",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_refill_1",
          metadata: {
            billingProduct: "goat_auto_refill",
            goatWorkspaceId: "workspace_1",
            amountCents: "2000",
          },
        },
      },
    });
    vi.mocked(recordGoatAutoRefillCredit).mockResolvedValue({ ok: false } as never);
    const response = await signedRequest(createStripeIngress({ db, stripe, webhookSecret: "x" }));
    expect(response.status).toBe(200);
    expect(recordGoatAutoRefillCredit).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      amountCents: 2_000,
      paymentIntentId: "pi_refill_1",
      db,
    });
    expect(settleGoatAutoRefill).toHaveBeenCalledWith({ workspaceId: "workspace_1" }, { db });
  });

  it("keeps legacy setup-mode events on the shared compatibility tables", async () => {
    constructEvent.mockReturnValue({
      id: "evt_legacy_setup",
      type: "checkout.session.completed",
      data: { object: { id: "cs_setup", mode: "setup", metadata: {} } },
    });
    const response = await signedRequest(createStripeIngress({ db, stripe, webhookSecret: "x" }));
    expect(response.status).toBe(200);
    expect(completeAutoRefillSetup).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cs_setup" }),
      { stripe, db },
    );
  });
});

function signedRequest(ingress: ReturnType<typeof createStripeIngress>) {
  return ingress.webhook(
    new Request("https://api.test/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "signature" },
      body: "event-body",
    }),
  );
}
