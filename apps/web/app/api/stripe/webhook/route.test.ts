import { beforeEach, describe, expect, it, vi } from "vitest";
import { fulfillCheckoutSession } from "@/lib/billing/service";
import { getStripe, getStripeWebhookSecret } from "@/lib/billing/stripe";
import { POST } from "./route";

vi.mock("@/lib/billing/service", () => ({
  fulfillCheckoutSession: vi.fn(),
}));

vi.mock("@/lib/billing/stripe", () => ({
  getStripe: vi.fn(),
  getStripeWebhookSecret: vi.fn(),
}));

const fulfillCheckoutSessionMock = vi.mocked(fulfillCheckoutSession);
const getStripeMock = vi.mocked(getStripe);
const getStripeWebhookSecretMock = vi.mocked(getStripeWebhookSecret);

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
  });
});
