import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGoatStripeAppWebhook } from "@/lib/integrations/stripe-app-webhook";

const webhookSecret = "whsec_opencompany";
const payload = JSON.stringify({
  id: "evt_123",
  object: "event",
  account: "acct_123",
  livemode: true,
  type: "account.application.deauthorized",
  data: { object: { id: "ca_123", object: "application" } },
});

beforeEach(() => {
  vi.stubEnv("GOAT_STRIPE_APP_WEBHOOK_SECRET", webhookSecret);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseGoatStripeAppWebhook", () => {
  it("verifies the Stripe signature before exposing lifecycle routing fields", () => {
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });

    expect(parseGoatStripeAppWebhook(payload, signature)).toEqual({
      type: "account.application.deauthorized",
      accountId: "acct_123",
      livemode: true,
    });
  });

  it("rejects a payload that no longer matches its signature", () => {
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
    });

    expect(() => parseGoatStripeAppWebhook(`${payload} `, signature)).toThrow();
  });
});
