import Stripe from "stripe";

export { getGoatAppUrl } from "@/lib/app-url";

let stripe: Stripe | undefined;

export function getGoatStripe() {
  const apiKey = process.env.GOAT_STRIPE_API_KEY?.trim();
  if (!apiKey) throw new Error("GOAT_STRIPE_API_KEY is required for OpenCompany billing.");
  stripe ??= new Stripe(apiKey, { apiVersion: "2026-04-22.dahlia" });
  return stripe;
}

export function getGoatProPriceId() {
  const priceId = process.env.GOAT_STRIPE_PRO_PRICE_ID?.trim();
  if (!priceId)
    throw new Error("GOAT_STRIPE_PRO_PRICE_ID is required for OpenCompany Pro billing.");
  return priceId;
}

export function assertGoatCheckoutEnabled() {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.GOAT_STRIPE_CHECKOUT_ENABLED !== "true"
  ) {
    throw new Error(
      "OpenCompany Pro Checkout is disabled until Stripe Tax registrations are configured.",
    );
  }
}
