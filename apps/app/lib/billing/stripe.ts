import Stripe from "stripe";

export { getAppUrl } from "@opencompany/core/app-url";

let stripe: Stripe | undefined;

export function getStripe() {
  const apiKey = process.env.STRIPE_API_KEY?.trim();
  if (!apiKey) throw new Error("STRIPE_API_KEY is required for OpenCompany billing.");
  stripe ??= new Stripe(apiKey, { apiVersion: "2026-04-22.dahlia" });
  return stripe;
}

export function getStripeWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is required for Stripe webhooks.");
  return secret;
}

export function assertCheckoutEnabled() {
  if (process.env.NODE_ENV === "production" && process.env.STRIPE_CHECKOUT_ENABLED !== "true") {
    throw new Error(
      "OpenCompany Checkout is disabled until Stripe Tax registrations are configured.",
    );
  }
}
