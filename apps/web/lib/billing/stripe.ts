import Stripe from "stripe";

let stripe: Stripe | undefined;

export function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is required for Stripe billing.");
  }

  stripe ??= new Stripe(secretKey);
  return stripe;
}

export function getStripeWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is required for Stripe webhooks.");
  }
  return secret;
}

export function getAppUrl() {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const redirectUri = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI?.trim();
  if (redirectUri) {
    return new URL(redirectUri).origin;
  }

  // Don't silently send customers to localhost after checkout in production.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_APP_URL (or NEXT_PUBLIC_WORKOS_REDIRECT_URI) is required in production to build billing redirect URLs.",
    );
  }
  return "http://localhost:3000";
}
