// Legacy-product auto-refill webhook handlers. The opencompany and legacy web
// products bill through the same Stripe account, so the shared webhook that
// now lives in this app still receives legacy setup-mode checkouts and
// auto-refill PaymentIntent events. Ported verbatim from the webhook section
// of the retired billing implementation; these write to the legacy
// (public-schema) billing tables, not goat.*.

import type Stripe from "stripe";
import {
  fulfillAutoRefill,
  markAutoRefillAttemptFailed,
  saveAutoRefillPaymentMethod,
} from "./legacy-credits";
import { getStripe } from "./stripe";

function stripeIdOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

// Completes a setup-mode checkout: retrieves the saved card, marks it the
// customer's default, and persists it so auto-refill can charge it off-session.
export async function completeAutoRefillSetup(
  session: Stripe.Checkout.Session,
  options: { stripe?: Stripe; db?: any } = {},
) {
  if (session.mode !== "setup") return;
  const workspaceId = session.metadata?.workspaceId;
  const customerId = stripeIdOf(session.customer);
  const setupIntentId = stripeIdOf(session.setup_intent);
  if (!workspaceId || !customerId || !setupIntentId) return;

  const stripe = options.stripe ?? getStripe();
  const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
  const paymentMethodId = stripeIdOf(setupIntent.payment_method);
  if (!paymentMethodId) return;

  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  await saveAutoRefillPaymentMethod({
    workspaceId,
    stripeCustomerId: customerId,
    paymentMethodId,
    cardBrand: paymentMethod.card?.brand ?? null,
    cardLast4: paymentMethod.card?.last4 ?? null,
    db: options.db,
  });
}

// Idempotent backstop for an off-session refill that succeeded — the inline path
// usually credits first; fulfillAutoRefill no-ops if already done.
export async function handleAutoRefillPaymentIntentSucceeded(
  paymentIntent: Stripe.PaymentIntent,
  eventId: string,
  options: { db?: any } = {},
) {
  if (paymentIntent.metadata?.kind !== "auto_refill") return;
  const attemptId = paymentIntent.metadata.attemptId;
  if (!attemptId) return;
  await fulfillAutoRefill({
    attemptId,
    stripePaymentIntentId: paymentIntent.id,
    eventId,
    db: options.db,
  });
}

export async function handleAutoRefillPaymentIntentFailed(
  paymentIntent: Stripe.PaymentIntent,
  options: { db?: any } = {},
) {
  if (paymentIntent.metadata?.kind !== "auto_refill") return;
  const attemptId = paymentIntent.metadata.attemptId;
  const workspaceId = paymentIntent.metadata.workspaceId;
  if (!attemptId || !workspaceId) return;
  await markAutoRefillAttemptFailed({
    attemptId,
    workspaceId,
    stripePaymentIntentId: paymentIntent.id,
    error: paymentIntent.last_payment_error?.message ?? "auto_refill_payment_failed",
    needsAttention: true,
    db: options.db,
  });
}
