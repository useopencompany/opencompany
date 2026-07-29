import Stripe from "stripe";

export type GoatStripeAppLifecycleEvent = {
  type: string;
  accountId: string | null;
  livemode: boolean;
};

export function parseGoatStripeAppWebhook(
  payload: string,
  signature: string,
): GoatStripeAppLifecycleEvent {
  const webhookSecret = requiredEnv("GOAT_STRIPE_APP_WEBHOOK_SECRET");
  const event = Stripe.webhooks.constructEvent(payload, signature, webhookSecret);
  return {
    type: event.type,
    accountId: typeof event.account === "string" ? event.account : null,
    livemode: event.livemode,
  };
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Stripe app webhooks.`);
  return value;
}
