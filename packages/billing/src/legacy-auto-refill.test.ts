import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeAutoRefillSetup,
  handleAutoRefillPaymentIntentFailed,
  handleAutoRefillPaymentIntentSucceeded,
} from "./legacy-auto-refill";
import {
  fulfillAutoRefill,
  markAutoRefillAttemptFailed,
  saveAutoRefillPaymentMethod,
} from "./legacy-credits";
import { getGoatStripe } from "./stripe";

vi.mock("./legacy-credits", () => ({
  fulfillAutoRefill: vi.fn(),
  markAutoRefillAttemptFailed: vi.fn(),
  saveAutoRefillPaymentMethod: vi.fn(),
}));

vi.mock("./stripe", () => ({
  getGoatStripe: vi.fn(),
}));

const fulfillAutoRefillMock = vi.mocked(fulfillAutoRefill);
const markAutoRefillAttemptFailedMock = vi.mocked(markAutoRefillAttemptFailed);
const saveAutoRefillPaymentMethodMock = vi.mocked(saveAutoRefillPaymentMethod);
const getGoatStripeMock = vi.mocked(getGoatStripe);

describe("shared legacy Stripe auto-refill compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists the card from an authorized setup Checkout session", async () => {
    const setupIntentsRetrieve = vi.fn().mockResolvedValue({ payment_method: "pm_123" });
    const paymentMethodsRetrieve = vi
      .fn()
      .mockResolvedValue({ card: { brand: "visa", last4: "4242" } });
    const customersUpdate = vi.fn().mockResolvedValue({});
    getGoatStripeMock.mockReturnValue({
      setupIntents: { retrieve: setupIntentsRetrieve },
      paymentMethods: { retrieve: paymentMethodsRetrieve },
      customers: { update: customersUpdate },
    } as never);

    await completeAutoRefillSetup({
      mode: "setup",
      customer: "cus_123",
      setup_intent: "seti_123",
      metadata: { workspaceId: "wks_123" },
    } as never);

    expect(setupIntentsRetrieve).toHaveBeenCalledWith("seti_123");
    expect(paymentMethodsRetrieve).toHaveBeenCalledWith("pm_123");
    expect(customersUpdate).toHaveBeenCalledWith("cus_123", {
      invoice_settings: { default_payment_method: "pm_123" },
    });
    expect(saveAutoRefillPaymentMethodMock).toHaveBeenCalledWith({
      workspaceId: "wks_123",
      stripeCustomerId: "cus_123",
      paymentMethodId: "pm_123",
      cardBrand: "visa",
      cardLast4: "4242",
    });
  });

  it("ignores setup sessions without tenant and Stripe ownership metadata", async () => {
    await completeAutoRefillSetup({ mode: "setup", metadata: {} } as never);

    expect(getGoatStripeMock).not.toHaveBeenCalled();
    expect(saveAutoRefillPaymentMethodMock).not.toHaveBeenCalled();
  });

  it("forwards legacy auto-refill success with the Stripe event id", async () => {
    await handleAutoRefillPaymentIntentSucceeded(
      {
        id: "pi_123",
        metadata: { kind: "auto_refill", attemptId: "ar_123" },
      } as never,
      "evt_123",
    );

    expect(fulfillAutoRefillMock).toHaveBeenCalledWith({
      attemptId: "ar_123",
      stripePaymentIntentId: "pi_123",
      eventId: "evt_123",
    });
  });

  it("marks legacy auto-refill failures for the owning workspace", async () => {
    await handleAutoRefillPaymentIntentFailed({
      id: "pi_123",
      metadata: { kind: "auto_refill", attemptId: "ar_123", workspaceId: "wks_123" },
      last_payment_error: { message: "Card declined" },
    } as never);

    expect(markAutoRefillAttemptFailedMock).toHaveBeenCalledWith({
      attemptId: "ar_123",
      workspaceId: "wks_123",
      stripePaymentIntentId: "pi_123",
      error: "Card declined",
      needsAttention: true,
    });
  });
});
