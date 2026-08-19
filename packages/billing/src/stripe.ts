import Stripe from "stripe";

let stripe: Stripe | undefined;

export function getStripe() {
  const apiKey = process.env.OPENCOMPANY_STRIPE_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENCOMPANY_STRIPE_API_KEY is required for opencompany billing.");
  stripe ??= new Stripe(apiKey, { apiVersion: "2026-04-22.dahlia" });
  return stripe;
}

export function getStripeWebhookSecret() {
  const secret = process.env.OPENCOMPANY_STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret)
    throw new Error("OPENCOMPANY_STRIPE_WEBHOOK_SECRET is required for Stripe webhooks.");
  return secret;
}

export function assertCheckoutEnabled() {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.OPENCOMPANY_STRIPE_CHECKOUT_ENABLED !== "true"
  ) {
    throw new Error(
      "opencompany Checkout is disabled until Stripe Tax registrations are configured.",
    );
  }
}
