import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";
import { captureServerEvent } from "@opencompany/analytics/server";
import {
  completeAutoRefillSetup,
  handleAutoRefillPaymentIntentFailed,
  handleAutoRefillPaymentIntentSucceeded,
} from "@opencompany/billing/legacy-auto-refill";
import { fulfillCheckoutSession } from "@opencompany/billing/legacy-credits";
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
        event = input.stripe.webhooks.constructEvent(
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
    const isGoatTopUp =
      session.mode === "payment" && session.metadata?.billingProduct === "goat_topup";
    if (isGoatTopUp && event.type === "checkout.session.async_payment_failed") {
      const checkoutRecordId = session.metadata?.checkoutRecordId;
      if (checkoutRecordId) {
        await markGoatCheckoutRecordFailed({
          id: checkoutRecordId,
          error: "Stripe reported that the delayed Checkout payment failed.",
          db: input.db,
        });
      }
      return;
    }
    if (isGoatTopUp) {
      const result = await fulfillGoatTopUpCheckoutSession(session, {
        eventId: event.id,
        db: input.db,
      });
      if (result.ok) await finalizeGoatTopUp(session, result, input);
      return;
    }
    if (event.type !== "checkout.session.completed") return;
    if (
      session.mode === "subscription" &&
      (session.metadata?.billingProduct === GOAT_PRO_STRIPE_PRODUCT_KEY ||
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
    await handleGoatSubscriptionEvent(event, input.db);
    return;
  }
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    await handleGoatInvoiceEvent(event, input.db);
    return;
  }
  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object;
    if (intent.metadata?.billingProduct === "goat_auto_refill") {
      await handleGoatAutoRefillPaymentIntentSucceeded(intent, input.db);
    } else {
      await handleAutoRefillPaymentIntentSucceeded(intent, event.id, { db: input.db });
    }
    return;
  }
  if (event.type === "payment_intent.payment_failed") {
    const intent = event.data.object;
    if (intent.metadata?.billingProduct === "goat_auto_refill") {
      await handleGoatAutoRefillPaymentIntentFailed(intent, input.db);
    } else {
      await handleAutoRefillPaymentIntentFailed(intent, { db: input.db });
    }
  }
}

async function finalizeGoatTopUp(
  session: Stripe.Checkout.Session,
  result: { amountCents: number; balanceCents: number; checkoutRecordId: string },
  input: { db: DbLike; stripe: Stripe },
) {
  const workspaceId = session.metadata?.goatWorkspaceId ?? "";
  await Promise.all([
    releasePendingForWorkspace(workspaceId, new Date(), input.db).catch((error) => {
      console.error(`Failed to release paused ingestion for ${workspaceId}.`, error);
    }),
    captureGoatTopUpPaymentMethod(session, input).catch((error) => {
      console.error(`Failed to capture the Goat top-up payment method for ${workspaceId}.`, error);
    }),
    captureGoatServerEvent(
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
      console.error(`Failed to capture the Goat top-up product event for ${workspaceId}.`, error);
    }),
    captureServerEvent("goat_billing_topup_completed", workspaceId, {
      workspace_id: workspaceId,
      checkout_record_id: result.checkoutRecordId,
      amount_cents: result.amountCents,
      amount_usd: result.amountCents / 100,
      balance_cents: result.balanceCents,
    }).catch((error) => {
      console.error(`Failed to capture the Goat top-up server event for ${workspaceId}.`, error);
    }),
  ]);
}

async function handleGoatSubscriptionEvent(
  event:
    | Stripe.CustomerSubscriptionCreatedEvent
    | Stripe.CustomerSubscriptionUpdatedEvent
    | Stripe.CustomerSubscriptionDeletedEvent,
  db: DbLike,
) {
  const subscription = event.data.object;
  const productKey = subscription.metadata.billingProduct;
  if (productKey !== GOAT_PRO_STRIPE_PRODUCT_KEY && productKey !== "goat") return;
  const storedWorkspaceId =
    productKey === GOAT_PRO_STRIPE_PRODUCT_KEY
      ? await findGoatWorkspaceIdForStripeSubscription(subscription.id, { db })
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
  const projection = await applyGoatStripeSubscriptionProjection(
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
      status: subscription.status as GoatStripeSubscriptionStatus,
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

async function handleGoatInvoiceEvent(
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
  const workspaceId = await findGoatWorkspaceIdForStripeSubscription(subscriptionId, { db });
  if (!workspaceId) return;
  const applied = await applyGoatStripeInvoicePaymentState(
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

async function handleGoatAutoRefillPaymentIntentSucceeded(
  intent: Stripe.PaymentIntent,
  db: DbLike,
) {
  const workspaceId = intent.metadata?.goatWorkspaceId;
  const amountCents = Number(intent.metadata?.amountCents);
  if (!workspaceId || !Number.isSafeInteger(amountCents) || amountCents <= 0) return;
  const credit = await recordGoatAutoRefillCredit({
    workspaceId,
    amountCents,
    paymentIntentId: intent.id,
    db,
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
  await settleGoatAutoRefill({ workspaceId }, { db }).catch(() => undefined);
  await releasePendingForWorkspace(workspaceId, new Date(), db).catch((error) => {
    console.error(`Failed to release paused ingestion for ${workspaceId}.`, error);
  });
}

async function handleGoatAutoRefillPaymentIntentFailed(intent: Stripe.PaymentIntent, db: DbLike) {
  const workspaceId = intent.metadata?.goatWorkspaceId;
  if (!workspaceId) return;
  await settleGoatAutoRefill(
    {
      workspaceId,
      disable: true,
      error:
        intent.last_payment_error?.message ?? "Stripe reported that the auto-refill charge failed.",
    },
    { db },
  );
}

async function captureGoatTopUpPaymentMethod(
  session: Stripe.Checkout.Session,
  input: { db: DbLike; stripe: Stripe },
) {
  const workspaceId = session.metadata?.goatWorkspaceId;
  const paymentIntentId = stripeObjectId(session.payment_intent);
  if (!workspaceId || !paymentIntentId) return;
  const intent = await input.stripe.paymentIntents.retrieve(paymentIntentId);
  const paymentMethodId = stripeObjectId(intent.payment_method);
  if (!paymentMethodId) return;
  await setGoatAutoRefillPaymentMethod({ workspaceId, paymentMethodId }, { db: input.db });
}

function stripeObjectId(value: string | { id: string } | null | undefined) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

function stripeError(message: string) {
  return Response.json({ error: message }, { status: 400 });
}
