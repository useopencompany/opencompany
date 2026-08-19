import { captureProductServerEvent } from "@opencompany/analytics/product/server";
import { captureServerEvent } from "@opencompany/analytics/server";
import {
  completeAutoRefillSetup,
  handleAutoRefillPaymentIntentFailed,
  handleAutoRefillPaymentIntentSucceeded,
} from "@opencompany/billing/legacy-auto-refill";
import { fulfillCheckoutSession } from "@opencompany/billing/legacy-credits";
import {
  applyStripeInvoicePaymentState,
  applyStripeSubscriptionProjection,
  findWorkspaceIdForStripeSubscription,
  PRO_STRIPE_PRODUCT_KEY,
  releasePendingForWorkspace,
  setAutoRefillPaymentMethod,
  settleAutoRefill,
} from "@opencompany/db/billing";
import {
  fulfillTopUpCheckoutSession,
  markCheckoutRecordFailed,
  recordAutoRefillCredit,
  usdMicrosToCents,
} from "@opencompany/db/credits";
import type { StripeSubscriptionStatus } from "@opencompany/db/product-schema";
import type Stripe from "stripe";

type DbLike = any;

export interface StripeIngressService {
  webhook(request: Request): Promise<Response>;
}

export function createStripeIngress(input: {
  db: DbLike;
  stripe: Stripe;
  webhookSecret: string;
}): StripeIngressService {
  return {
    async webhook(request) {
      const signature = request.headers.get("stripe-signature");
      if (!signature) return stripeError("Missing Stripe signature.");

      let event: Stripe.Event;
      try {
        // Stripe signs the exact incoming bytes. Reading the body as text here
        // preserves that raw payload and must happen before any JSON parsing.
        event = await input.stripe.webhooks.constructEventAsync(
          await request.text(),
          signature,
          input.webhookSecret,
        );
      } catch {
        return stripeError("Invalid Stripe webhook signature.");
      }

      await handleStripeEvent(event, input);
      return Response.json({ received: true });
    },
  };
}

async function handleStripeEvent(event: Stripe.Event, input: { db: DbLike; stripe: Stripe }) {
  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded" ||
    event.type === "checkout.session.async_payment_failed"
  ) {
    const session = event.data.object;
    const isTopUp = session.mode === "payment" && session.metadata?.billingProduct === "goat_topup";
    if (isTopUp && event.type === "checkout.session.async_payment_failed") {
      const checkoutRecordId = session.metadata?.checkoutRecordId;
      if (checkoutRecordId) {
        await markCheckoutRecordFailed({
          id: checkoutRecordId,
          error: "Stripe reported that the delayed Checkout payment failed.",
          db: input.db,
        });
      }
      return;
    }
    if (isTopUp) {
      const result = await fulfillTopUpCheckoutSession(session, {
        eventId: event.id,
        db: input.db,
      });
      if (result.ok) await finalizeTopUp(session, result, input);
      return;
    }
    if (event.type !== "checkout.session.completed") return;
    if (
      session.mode === "subscription" &&
      (session.metadata?.billingProduct === PRO_STRIPE_PRODUCT_KEY ||
        session.metadata?.billingProduct === "goat")
    ) {
      // Subscription lifecycle events remain the seat and plan authority.
      return;
    }
    if (session.mode === "setup") {
      await completeAutoRefillSetup(session, { stripe: input.stripe, db: input.db });
      return;
    }
    const result = await fulfillCheckoutSession(session, { eventId: event.id, db: input.db });
    if (result.ok) {
      await captureServerEvent("credit_top_up_completed", result.userId, {
        user_id: result.userId,
        workspace_id: result.workspaceId,
        checkout_record_id: result.checkoutRecordId,
        ledger_id: result.ledgerId,
        amount_cents: result.amountCents,
        balance_cents: result.balanceCents,
      }).catch((error) => {
        console.error(
          `Failed to capture the legacy top-up event for ${result.workspaceId}.`,
          error,
        );
      });
    }
    return;
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    await handleSubscriptionEvent(event, input.db);
    return;
  }
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    await handleInvoiceEvent(event, input.db);
    return;
  }
  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object;
    if (intent.metadata?.billingProduct === "goat_auto_refill") {
      await handleProductAutoRefillPaymentIntentSucceeded(intent, input.db);
    } else {
      await handleAutoRefillPaymentIntentSucceeded(intent, event.id, { db: input.db });
    }
    return;
  }
  if (event.type === "payment_intent.payment_failed") {
    const intent = event.data.object;
    if (intent.metadata?.billingProduct === "goat_auto_refill") {
      await handleProductAutoRefillPaymentIntentFailed(intent, input.db);
    } else {
      await handleAutoRefillPaymentIntentFailed(intent, { db: input.db });
    }
  }
}

async function finalizeTopUp(
  session: Stripe.Checkout.Session,
  result: { amountCents: number; balanceCents: number; checkoutRecordId: string },
  input: { db: DbLike; stripe: Stripe },
) {
  const workspaceId = session.metadata?.workspaceId ?? "";
  await Promise.all([
    releasePendingForWorkspace(workspaceId, new Date(), input.db).catch((error) => {
      console.error(`Failed to release paused ingestion for ${workspaceId}.`, error);
    }),
    captureTopUpPaymentMethod(session, input).catch((error) => {
      console.error(
        `Failed to capture the opencompany top-up payment method for ${workspaceId}.`,
        error,
      );
    }),
    captureProductServerEvent(
      "billing_topup_completed",
      session.metadata?.userWorkosId ?? workspaceId,
      {
        workspace_id: workspaceId,
        topup_type: "manual",
        amount_cents: result.amountCents,
        amount_usd: result.amountCents / 100,
        balance_cents: result.balanceCents,
      },
    ).catch((error) => {
      console.error(
        `Failed to capture the opencompany top-up product event for ${workspaceId}.`,
        error,
      );
    }),
    captureServerEvent("goat_billing_topup_completed", workspaceId, {
      workspace_id: workspaceId,
      checkout_record_id: result.checkoutRecordId,
      amount_cents: result.amountCents,
      amount_usd: result.amountCents / 100,
      balance_cents: result.balanceCents,
    }).catch((error) => {
      console.error(
        `Failed to capture the opencompany top-up server event for ${workspaceId}.`,
        error,
      );
    }),
  ]);
}

async function handleSubscriptionEvent(
  event:
    | Stripe.CustomerSubscriptionCreatedEvent
    | Stripe.CustomerSubscriptionUpdatedEvent
    | Stripe.CustomerSubscriptionDeletedEvent,
  db: DbLike,
) {
  const subscription = event.data.object;
  const productKey = subscription.metadata.billingProduct;
  if (productKey !== PRO_STRIPE_PRODUCT_KEY && productKey !== "goat") return;
  const storedWorkspaceId =
    productKey === PRO_STRIPE_PRODUCT_KEY
      ? await findWorkspaceIdForStripeSubscription(subscription.id, { db })
      : null;
  const workspaceId = subscription.metadata.workspaceId?.trim() || storedWorkspaceId;
  if (!workspaceId) return;

  const item = subscription.items.data[0] ?? null;
  const itemWithPeriod = item as
    | (Stripe.SubscriptionItem & {
        current_period_start?: number | null;
        current_period_end?: number | null;
      })
    | null;
  const customerId = stripeObjectId(subscription.customer);
  if (!customerId) throw new Error("opencompany seat subscription is missing its customer id.");
  const projection = await applyStripeSubscriptionProjection(
    {
      eventId: event.id,
      eventType: event.type,
      eventCreatedAt: new Date(event.created * 1_000),
      workspaceId,
      customerId,
      subscriptionId: subscription.id,
      subscriptionItemId: item?.id ?? null,
      priceId: item ? stripeObjectId(item.price) : null,
      productKey,
      status: subscription.status as StripeSubscriptionStatus,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodStart: itemWithPeriod?.current_period_start
        ? new Date(itemWithPeriod.current_period_start * 1_000)
        : null,
      currentPeriodEnd: itemWithPeriod?.current_period_end
        ? new Date(itemWithPeriod.current_period_end * 1_000)
        : null,
      seatQuantity: item?.quantity ?? 1,
    },
    { db },
  );
  if (projection.applied && projection.planChanged) {
    await captureServerEvent("goat_billing_plan_changed", workspaceId, {
      workspace_id: workspaceId,
      plan: projection.plan,
      subscription_status: subscription.status,
    });
  }
}

async function handleInvoiceEvent(
  event: Stripe.InvoicePaidEvent | Stripe.InvoicePaymentFailedEvent,
  db: DbLike,
) {
  const invoice = event.data.object;
  const legacySubscription = (
    invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null }
  ).subscription;
  const subscriptionId =
    stripeObjectId(invoice.parent?.subscription_details?.subscription) ??
    stripeObjectId(legacySubscription);
  if (!subscriptionId) return;
  const workspaceId = await findWorkspaceIdForStripeSubscription(subscriptionId, { db });
  if (!workspaceId) return;
  const applied = await applyStripeInvoicePaymentState(
    {
      eventId: event.id,
      eventType: event.type,
      eventCreatedAt: new Date(event.created * 1_000),
      subscriptionId,
      needsAttention: event.type === "invoice.payment_failed",
    },
    { db },
  );
  if (applied && event.type === "invoice.payment_failed") {
    await captureServerEvent("goat_billing_payment_failed", workspaceId, {
      workspace_id: workspaceId,
      subscription_id: subscriptionId,
    });
  }
}

async function handleProductAutoRefillPaymentIntentSucceeded(
  intent: Stripe.PaymentIntent,
  db: DbLike,
) {
  const workspaceId = intent.metadata?.workspaceId;
  const amountCents = Number(intent.metadata?.amountCents);
  if (!workspaceId || !Number.isSafeInteger(amountCents) || amountCents <= 0) return;
  const credit = await recordAutoRefillCredit({
    workspaceId,
    amountCents,
    paymentIntentId: intent.id,
    db,
  });
  if (credit.ok) {
    await captureProductServerEvent("billing_topup_completed", workspaceId, {
      workspace_id: workspaceId,
      topup_type: "auto_refill",
      amount_cents: amountCents,
      amount_usd: amountCents / 100,
      balance_cents: usdMicrosToCents(credit.balanceUsdMicros),
    });
  }
  await settleAutoRefill({ workspaceId }, { db }).catch(() => undefined);
  await releasePendingForWorkspace(workspaceId, new Date(), db).catch((error) => {
    console.error(`Failed to release paused ingestion for ${workspaceId}.`, error);
  });
}

async function handleProductAutoRefillPaymentIntentFailed(
  intent: Stripe.PaymentIntent,
  db: DbLike,
) {
  const workspaceId = intent.metadata?.workspaceId;
  if (!workspaceId) return;
  await settleAutoRefill(
    {
      workspaceId,
      disable: true,
      error:
        intent.last_payment_error?.message ?? "Stripe reported that the auto-refill charge failed.",
    },
    { db },
  );
}

async function captureTopUpPaymentMethod(
  session: Stripe.Checkout.Session,
  input: { db: DbLike; stripe: Stripe },
) {
  const workspaceId = session.metadata?.workspaceId;
  const paymentIntentId = stripeObjectId(session.payment_intent);
  if (!workspaceId || !paymentIntentId) return;
  const intent = await input.stripe.paymentIntents.retrieve(paymentIntentId);
  const paymentMethodId = stripeObjectId(intent.payment_method);
  if (!paymentMethodId) return;
  await setAutoRefillPaymentMethod({ workspaceId, paymentMethodId }, { db: input.db });
}

function stripeObjectId(value: string | { id: string } | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function stripeError(message: string) {
  return Response.json({ error: message }, { status: 400 });
}
