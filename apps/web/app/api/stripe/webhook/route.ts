import { captureServerEvent } from "@opencompany/analytics/server";
import {
  applyGoatStripeInvoicePaymentState,
  applyGoatStripeSubscriptionProjection,
  findGoatWorkspaceIdForStripeSubscription,
  GOAT_PRO_MONTHLY_SEAT_PRICE_EUR_CENTS,
} from "@opencompany/db/goat-billing";
import type { GoatStripeSubscriptionStatus } from "@opencompany/db/goat-schema";
import { after, NextResponse } from "next/server";
import Stripe from "stripe";
import {
  completeAutoRefillSetup,
  handleAutoRefillPaymentIntentFailed,
  handleAutoRefillPaymentIntentSucceeded,
} from "@/lib/billing/auto-refill";
import { fulfillCheckoutSession } from "@/lib/billing/service";
import { getStripe, getStripeWebhookSecret } from "@/lib/billing/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe signature." }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      await request.text(),
      signature,
      getStripeWebhookSecret(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid Stripe webhook.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.mode === "subscription" && session.metadata?.billingProduct === "goat") {
      // The subscription lifecycle events carry the complete item/status data
      // and project the entitlement. Checkout completion is intentionally a
      // no-op here so event ordering cannot grant access from partial data.
      return NextResponse.json({ received: true });
    }
    // Setup-mode checkouts save a card for auto-refill; payment-mode checkouts are
    // one-time credit top-ups handled by fulfillCheckoutSession.
    if (session.mode === "setup") {
      await completeAutoRefillSetup(session);
    } else {
      const result = await fulfillCheckoutSession(session, { eventId: event.id });

      if (result.ok) {
        after(() =>
          captureServerEvent("credit_top_up_completed", result.userId, {
            user_id: result.userId,
            workspace_id: result.workspaceId,
            checkout_record_id: result.checkoutRecordId,
            ledger_id: result.ledgerId,
            amount_cents: result.amountCents,
            balance_cents: result.balanceCents,
          }),
        );
      }
    }
  } else if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    await handleGoatSubscriptionEvent(event);
  } else if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    await handleGoatInvoiceEvent(event);
  } else if (event.type === "payment_intent.succeeded") {
    await handleAutoRefillPaymentIntentSucceeded(event.data.object, event.id);
  } else if (event.type === "payment_intent.payment_failed") {
    await handleAutoRefillPaymentIntentFailed(event.data.object);
  }

  return NextResponse.json({ received: true });
}

async function handleGoatSubscriptionEvent(
  event:
    | Stripe.CustomerSubscriptionCreatedEvent
    | Stripe.CustomerSubscriptionUpdatedEvent
    | Stripe.CustomerSubscriptionDeletedEvent,
) {
  const subscription = event.data.object;
  const metadata = subscription.metadata;
  let workspaceId = metadata.goatWorkspaceId?.trim() || null;
  if (!workspaceId) {
    workspaceId = await findGoatWorkspaceIdForStripeSubscription(subscription.id);
  }
  if (metadata.billingProduct !== "goat" && !workspaceId) return;
  if (!workspaceId) return;
  const item = subscription.items.data[0] ?? null;
  const customerId = stripeObjectId(subscription.customer);
  if (!customerId) throw new Error("Goat Stripe subscription is missing its customer id.");
  const projection = await applyGoatStripeSubscriptionProjection({
    eventId: event.id,
    eventType: event.type,
    eventCreatedAt: new Date(event.created * 1_000),
    workspaceId,
    customerId,
    subscriptionId: subscription.id,
    subscriptionItemId: item?.id ?? null,
    priceId: item ? stripeObjectId(item.price) : null,
    status: subscription.status as GoatStripeSubscriptionStatus,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1_000) : null,
    seatQuantity: Math.max(1, item?.quantity ?? 1),
  });
  if (!projection.applied) return;
  if (projection.planChanged) {
    await captureServerEvent("goat_billing_plan_changed", workspaceId, {
      workspace_id: workspaceId,
      plan: projection.plan,
      subscription_status: subscription.status,
    });
    if (projection.plan === "pro") {
      const seatQuantity = Math.max(1, item?.quantity ?? 1);
      await captureServerEvent("goat_billing_checkout_completed", workspaceId, {
        workspace_id: workspaceId,
        seat_quantity: seatQuantity,
        subtotal_eur_cents: seatQuantity * GOAT_PRO_MONTHLY_SEAT_PRICE_EUR_CENTS,
      });
    }
  }
  if (projection.cancellationScheduled) {
    await captureServerEvent("goat_billing_cancellation_scheduled", workspaceId, {
      workspace_id: workspaceId,
      current_period_end: item?.current_period_end
        ? new Date(item.current_period_end * 1_000).toISOString()
        : null,
    });
  }
}

async function handleGoatInvoiceEvent(
  event: Stripe.InvoicePaidEvent | Stripe.InvoicePaymentFailedEvent,
) {
  const invoice = event.data.object;
  const parent = invoice.parent?.subscription_details?.subscription;
  const legacySubscription = (
    invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null }
  ).subscription;
  const subscriptionId = stripeObjectId(parent) ?? stripeObjectId(legacySubscription);
  if (!subscriptionId) return;
  const workspaceId = await findGoatWorkspaceIdForStripeSubscription(subscriptionId);
  if (!workspaceId) return;
  const applied = await applyGoatStripeInvoicePaymentState({
    eventId: event.id,
    eventType: event.type,
    eventCreatedAt: new Date(event.created * 1_000),
    subscriptionId,
    needsAttention: event.type === "invoice.payment_failed",
  });
  if (applied && event.type === "invoice.payment_failed") {
    await captureServerEvent("goat_billing_payment_failed", workspaceId, {
      workspace_id: workspaceId,
      subscription_id: subscriptionId,
    });
  }
}

function stripeObjectId(value: string | { id: string } | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}
