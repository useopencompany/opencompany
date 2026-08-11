import Stripe from "stripe";

let stripe: Stripe | undefined;

export function getGoatStripe() {
  const apiKey = process.env.GOAT_STRIPE_API_KEY?.trim();
  if (!apiKey) throw new Error("GOAT_STRIPE_API_KEY is required for OpenCompany billing.");
  stripe ??= new Stripe(apiKey, { apiVersion: "2026-04-22.dahlia" });
  return stripe;
}

export function getGoatStripeWebhookSecret() {
  const secret = process.env.GOAT_STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error("GOAT_STRIPE_WEBHOOK_SECRET is required for Stripe webhooks.");
  return secret;
}

export function assertGoatCheckoutEnabled() {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.GOAT_STRIPE_CHECKOUT_ENABLED !== "true"
  ) {
    throw new Error(
      "OpenCompany Checkout is disabled until Stripe Tax registrations are configured.",
    );
  }
}
