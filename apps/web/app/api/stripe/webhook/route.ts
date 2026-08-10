import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";
import { captureServerEvent } from "@opencompany/analytics/server";
import {
  applyGoatStripeInvoicePaymentState,
  applyGoatStripeSubscriptionProjection,
  findGoatWorkspaceIdForStripeSubscription,
  GOAT_PRO_STRIPE_PRODUCT_KEY,
  releasePendingForWorkspace,
  setGoatAutoRefillPaymentMethod,
  settleGoatAutoRefill,
} from "@opencompany/db/goat-billing";
import {
  fulfillGoatTopUpCheckoutSession,
  goatUsdMicrosToCents,
  markGoatCheckoutRecordFailed,
  recordGoatAutoRefillCredit,
} from "@opencompany/db/goat-credits";
import type { GoatStripeSubscriptionStatus } from "@opencompany/db/goat-schema";
import { after, NextResponse } from "next/server";
import type Stripe from "stripe";
import {
  completeAutoRefillSetup,
  handleAutoRefillPaymentIntentFailed,
  handleAutoRefillPaymentIntentSucceeded,
} from "@/lib/billing/legacy-auto-refill";
import { fulfillCheckoutSession } from "@/lib/billing/legacy-credits";
import { getGoatStripe, getGoatStripeWebhookSecret } from "@/lib/billing/stripe";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe signature." }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = getGoatStripe().webhooks.constructEvent(
      await request.text(),
      signature,
      getGoatStripeWebhookSecret(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid Stripe webhook.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded" ||
    event.type === "checkout.session.async_payment_failed"
  ) {
    const session = event.data.object;
    const isGoatTopUp =
      session.mode === "payment" && session.metadata?.billingProduct === "goat_topup";
    if (isGoatTopUp && event.type === "checkout.session.async_payment_failed") {
      const checkoutRecordId = session.metadata?.checkoutRecordId;
      if (checkoutRecordId) {
        await markGoatCheckoutRecordFailed({
          id: checkoutRecordId,
          error: "Stripe reported that the delayed Checkout payment failed.",
        });
      }
      return NextResponse.json({ received: true });
    }
    // Goat credit top-ups can complete immediately or after a delayed payment
    // method succeeds. Fulfillment itself verifies payment_status and is
    // idempotent across both webhook events and Stripe retries.
    if (isGoatTopUp) {
      const result = await fulfillGoatTopUpCheckoutSession(session, { eventId: event.id });
      if (result.ok) {
        const workspaceId = session.metadata?.goatWorkspaceId ?? "";
        after(async () => {
          // Resume balance-paused ingestion immediately and save the card for
          // auto-refill; both are best-effort against the fulfilled credit.
          await releasePendingForWorkspace(workspaceId).catch((error) => {
            console.error(`Failed to release paused ingestion for ${workspaceId}.`, error);
          });
          await captureGoatTopUpPaymentMethod(session).catch((error) => {
            console.error(`Failed to capture the Goat top-up payment method.`, error);
          });
          await captureGoatServerEvent(
            "billing_topup_completed",
            session.metadata?.userWorkosId ?? workspaceId,
            {
              workspace_id: workspaceId,
              topup_type: "manual",
              amount_cents: result.amountCents,
              amount_usd: result.amountCents / 100,
              balance_cents: result.balanceCents,
            },
          );
          await captureServerEvent("goat_billing_topup_completed", workspaceId, {
            workspace_id: workspaceId,
            checkout_record_id: result.checkoutRecordId,
            amount_cents: result.amountCents,
            amount_usd: result.amountCents / 100,
            balance_cents: result.balanceCents,
          });
        });
      }
      return NextResponse.json({ received: true });
    }
    // Async Checkout outcomes are only enabled for Goat top-ups here. Legacy
    // credit fulfillment retains its existing completed-event contract.
    if (event.type !== "checkout.session.completed") {
      return NextResponse.json({ received: true });
    }
    if (
      session.mode === "subscription" &&
      (session.metadata?.billingProduct === GOAT_PRO_STRIPE_PRODUCT_KEY ||
        session.metadata?.billingProduct === "goat")
    ) {
      // Subscription lifecycle events carry the authoritative item and status.
      // Checkout completion is a no-op so event ordering cannot grant seats from
      // partial Checkout data.
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
    const intent = event.data.object;
    if (intent.metadata?.billingProduct === "goat_auto_refill") {
      await handleGoatAutoRefillPaymentIntentSucceeded(intent);
    } else {
      await handleAutoRefillPaymentIntentSucceeded(intent, event.id);
    }
  } else if (event.type === "payment_intent.payment_failed") {
    const intent = event.data.object;
    if (intent.metadata?.billingProduct === "goat_auto_refill") {
      await handleGoatAutoRefillPaymentIntentFailed(intent);
    } else {
      await handleAutoRefillPaymentIntentFailed(intent);
    }
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
  const productKey = subscription.metadata.billingProduct;
  if (productKey !== GOAT_PRO_STRIPE_PRODUCT_KEY && productKey !== "goat") return;
  const storedWorkspaceId =
    productKey === GOAT_PRO_STRIPE_PRODUCT_KEY
      ? await findGoatWorkspaceIdForStripeSubscription(subscription.id)
      : null;
  const workspaceId = subscription.metadata.goatWorkspaceId?.trim() || storedWorkspaceId;
  if (!workspaceId) return;

  const item = subscription.items.data[0] ?? null;
  const itemWithPeriod = item as
    | (Stripe.SubscriptionItem & {
        current_period_start?: number | null;
        current_period_end?: number | null;
      })
    | null;
  const customerId = stripeObjectId(subscription.customer);
  if (!customerId) throw new Error("OpenCompany seat subscription is missing its customer id.");
  const projection = await applyGoatStripeSubscriptionProjection({
    eventId: event.id,
    eventType: event.type,
    eventCreatedAt: new Date(event.created * 1_000),
    workspaceId,
    customerId,
    subscriptionId: subscription.id,
    subscriptionItemId: item?.id ?? null,
    priceId: item ? stripeObjectId(item.price) : null,
    productKey,
    status: subscription.status as GoatStripeSubscriptionStatus,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodStart: itemWithPeriod?.current_period_start
      ? new Date(itemWithPeriod.current_period_start * 1_000)
      : null,
    currentPeriodEnd: itemWithPeriod?.current_period_end
      ? new Date(itemWithPeriod.current_period_end * 1_000)
      : null,
    seatQuantity: item?.quantity ?? 1,
  });
  if (!projection.applied) return;

  if (projection.planChanged) {
    await captureServerEvent("goat_billing_plan_changed", workspaceId, {
      workspace_id: workspaceId,
      plan: projection.plan,
      subscription_status: subscription.status,
    });
  }
}

async function handleGoatInvoiceEvent(
  event: Stripe.InvoicePaidEvent | Stripe.InvoicePaymentFailedEvent,
) {
  const invoice = event.data.object;
  const parentSubscription = invoice.parent?.subscription_details?.subscription;
  const legacySubscription = (
    invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null }
  ).subscription;
  const subscriptionId = stripeObjectId(parentSubscription) ?? stripeObjectId(legacySubscription);
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

// The webhook is the durable path for goat auto-refill charges: the pi:{id}
// ledger idempotency key means this and the synchronous confirm path can both
// credit without double-counting, and a crash after PaymentIntent creation
// still lands the credit here.
async function handleGoatAutoRefillPaymentIntentSucceeded(intent: Stripe.PaymentIntent) {
  const workspaceId = intent.metadata?.goatWorkspaceId;
  const amountCents = Number(intent.metadata?.amountCents);
  if (!workspaceId || !Number.isSafeInteger(amountCents) || amountCents <= 0) return;
  const credit = await recordGoatAutoRefillCredit({
    workspaceId,
    amountCents,
    paymentIntentId: intent.id,
  });
  if (credit.ok) {
    await captureGoatServerEvent("billing_topup_completed", workspaceId, {
      workspace_id: workspaceId,
      topup_type: "auto_refill",
      amount_cents: amountCents,
      amount_usd: amountCents / 100,
      balance_cents: goatUsdMicrosToCents(credit.balanceUsdMicros),
    });
  }
  await settleGoatAutoRefill({ workspaceId }).catch(() => undefined);
  await releasePendingForWorkspace(workspaceId).catch((error) => {
    console.error(`Failed to release paused ingestion for ${workspaceId}.`, error);
  });
}

async function handleGoatAutoRefillPaymentIntentFailed(intent: Stripe.PaymentIntent) {
  const workspaceId = intent.metadata?.goatWorkspaceId;
  if (!workspaceId) return;
  await settleGoatAutoRefill({
    workspaceId,
    disable: true,
    error:
      intent.last_payment_error?.message ?? "Stripe reported that the auto-refill charge failed.",
  });
}

// The card used for a successful top-up becomes the auto-refill payment
// method (latest top-up wins). setup_future_usage on the Checkout payment
// intent already attached it to the customer for off-session use.
async function captureGoatTopUpPaymentMethod(session: Stripe.Checkout.Session) {
  const workspaceId = session.metadata?.goatWorkspaceId;
  const paymentIntentId = stripeObjectId(session.payment_intent);
  if (!workspaceId || !paymentIntentId) return;
  const intent = await getGoatStripe().paymentIntents.retrieve(paymentIntentId);
  const paymentMethodId = stripeObjectId(intent.payment_method);
  if (!paymentMethodId) return;
  await setGoatAutoRefillPaymentMethod({ workspaceId, paymentMethodId });
}

function stripeObjectId(value: string | { id: string } | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}
