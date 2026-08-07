"use server";

import { randomUUID } from "node:crypto";
import { captureServerEvent } from "@opencompany/analytics/server";
import {
  GOAT_PRO_MONTHLY_PRICE_USD_CENTS,
  GOAT_PRO_STRIPE_PRODUCT_KEY,
  loadGoatBillingOverview,
  setGoatAutoRefillConfig,
  setGoatStripeCustomerId,
} from "@opencompany/db/billing";
import {
  GOAT_MAX_TOP_UP_USD_CENTS,
  GOAT_MIN_TOP_UP_USD_CENTS,
} from "@opencompany/db/billing-constants";
import {
  createGoatPendingCheckoutRecord,
  markGoatCheckoutRecordFailed,
  markGoatCheckoutRecordOpen,
} from "@opencompany/db/credits";
import { redirect } from "next/navigation";
import { currentGoatUser } from "@/lib/auth";
import { assertGoatCheckoutEnabled, getGoatAppUrl, getGoatStripe } from "@/lib/billing/stripe";

export type GoatBillingActionResult = { ok: false; error: string } | never;

function billingError(error: unknown, fallback: string): GoatBillingActionResult {
  return {
    ok: false,
    error: error instanceof Error ? error.message : fallback,
  };
}

async function ensureGoatStripeCustomerId(context: {
  workspaceId: string;
  workspaceName: string;
  email: string;
  existingCustomerId: string | null;
}) {
  if (context.existingCustomerId) return context.existingCustomerId;
  const customer = await getGoatStripe().customers.create({
    email: context.email,
    name: context.workspaceName,
    metadata: { goatWorkspaceId: context.workspaceId },
  });
  return (
    (await setGoatStripeCustomerId({
      workspaceId: context.workspaceId,
      stripeCustomerId: customer.id,
    })) ?? customer.id
  );
}

// Purchased credits are a Pro entitlement and change shared workspace billing,
// so only workspace admins may start Checkout.
export async function createGoatCreditTopUpAction(
  amountCents: number,
): Promise<GoatBillingActionResult> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can add credits." };
  }
  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents < GOAT_MIN_TOP_UP_USD_CENTS ||
    amountCents > GOAT_MAX_TOP_UP_USD_CENTS
  ) {
    return {
      ok: false,
      error: `Credit top-ups must be between $${GOAT_MIN_TOP_UP_USD_CENTS / 100} and $${GOAT_MAX_TOP_UP_USD_CENTS / 100}.`,
    };
  }
  let checkoutUrl: string;
  const checkoutRecordId = `goat_chk_${randomUUID().replace(/-/g, "")}`;
  try {
    const overview = await loadGoatBillingOverview(context.workspace.id);
    if (overview.billing.plan !== "pro") {
      return { ok: false, error: "Upgrade this workspace to Pro before adding credits." };
    }
    assertGoatCheckoutEnabled();
    const customerId = await ensureGoatStripeCustomerId({
      workspaceId: context.workspace.id,
      workspaceName: context.workspace.name,
      email: context.authUser.email,
      existingCustomerId: overview.billing.stripeCustomerId,
    });
    await createGoatPendingCheckoutRecord({
      id: checkoutRecordId,
      workspaceId: context.workspace.id,
      userWorkosId: context.user.workosUserId,
      amountCents,
    });
    const appUrl = getGoatAppUrl();
    const session = await getGoatStripe().checkout.sessions.create({
      mode: "payment",
      customer: customerId,
      allow_promotion_codes: true,
      success_url: `${appUrl}/settings/workspace/billing?topup=success`,
      cancel_url: `${appUrl}/settings/workspace/billing?topup=cancelled`,
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      customer_update: { address: "auto", name: "auto" },
      // Save the card for off-session auto-refill charges; the webhook records
      // the resulting payment method on fulfillment.
      payment_intent_data: { setup_future_usage: "off_session" },
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            tax_behavior: "exclusive",
            product_data: {
              name: "OpenCompany credits",
              description: "Usage credits for chat and brain ingestion",
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        billingProduct: "goat_topup",
        goatWorkspaceId: context.workspace.id,
        userWorkosId: context.user.workosUserId,
        checkoutRecordId,
        amountCents: String(amountCents),
      },
    });
    if (!session.url) {
      await markGoatCheckoutRecordFailed({
        id: checkoutRecordId,
        error: "Stripe did not return a Checkout URL.",
      });
      return { ok: false, error: "Stripe did not return a Checkout URL." };
    }
    await markGoatCheckoutRecordOpen({
      id: checkoutRecordId,
      stripeCheckoutSessionId: session.id,
      metadata: {
        goatWorkspaceId: context.workspace.id,
        userWorkosId: context.user.workosUserId,
        checkoutRecordId,
        amountCents: String(amountCents),
      },
    });
    await captureServerEvent("goat_billing_topup_started", context.user.workosUserId, {
      user_id: context.user.workosUserId,
      workspace_id: context.workspace.id,
      amount_cents: amountCents,
    });
    checkoutUrl = session.url;
  } catch (error) {
    await markGoatCheckoutRecordFailed({
      id: checkoutRecordId,
      error: error instanceof Error ? error.message : "Top-up checkout failed to start.",
    }).catch(() => undefined);
    return billingError(error, "Could not start the credit top-up checkout.");
  }
  redirect(checkoutUrl);
}

export async function createGoatProCheckoutAction(): Promise<GoatBillingActionResult> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can change the plan." };
  }

  let checkoutUrl: string;
  try {
    assertGoatCheckoutEnabled();
    const overview = await loadGoatBillingOverview(context.workspace.id);
    if (overview.billing.plan === "pro") {
      return { ok: false, error: "This workspace already has an active seat subscription." };
    }
    if (
      overview.billing.stripeSubscriptionId &&
      overview.billing.subscriptionStatus !== "canceled" &&
      overview.billing.subscriptionStatus !== "incomplete_expired"
    ) {
      return {
        ok: false,
        error: "This workspace already has a Stripe subscription. Open billing management instead.",
      };
    }

    const customerId = await ensureGoatStripeCustomerId({
      workspaceId: context.workspace.id,
      workspaceName: context.workspace.name,
      email: context.authUser.email,
      existingCustomerId: overview.billing.stripeCustomerId,
    });
    const stripe = getGoatStripe();
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 10,
    });
    const existingPro = subscriptions.data.find(
      (subscription) =>
        subscription.metadata.billingProduct === GOAT_PRO_STRIPE_PRODUCT_KEY &&
        subscription.status !== "canceled" &&
        subscription.status !== "incomplete_expired",
    );
    if (existingPro) {
      return {
        ok: false,
        error: "This workspace already has a seat subscription. Open billing management instead.",
      };
    }
    const seatQuantity = Math.max(1, Math.floor(overview.memberCount ?? 1));
    const appUrl = getGoatAppUrl();
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        allow_promotion_codes: true,
        success_url: `${appUrl}/settings/workspace/billing?checkout=success`,
        cancel_url: `${appUrl}/settings/workspace/billing?checkout=cancelled`,
        automatic_tax: { enabled: true },
        billing_address_collection: "required",
        tax_id_collection: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: GOAT_PRO_MONTHLY_PRICE_USD_CENTS,
              tax_behavior: "exclusive",
              recurring: { interval: "month" },
              product_data: {
                name: "OpenCompany seat",
                description: "$20/month with $20/month of included at-cost usage",
              },
            },
            quantity: seatQuantity,
          },
        ],
        metadata: {
          billingProduct: GOAT_PRO_STRIPE_PRODUCT_KEY,
          goatWorkspaceId: context.workspace.id,
        },
        subscription_data: {
          metadata: {
            billingProduct: GOAT_PRO_STRIPE_PRODUCT_KEY,
            goatWorkspaceId: context.workspace.id,
          },
        },
      },
      {
        idempotencyKey: `goat-pro-${context.workspace.id}-${Math.floor(Date.now() / 3_600_000)}`,
      },
    );
    if (!session.url) return { ok: false, error: "Stripe did not return a Checkout URL." };

    await captureServerEvent("goat_billing_pro_checkout_started", context.user.workosUserId, {
      user_id: context.user.workosUserId,
      workspace_id: context.workspace.id,
      monthly_price_usd_cents: GOAT_PRO_MONTHLY_PRICE_USD_CENTS,
    });
    checkoutUrl = session.url;
  } catch (error) {
    return billingError(error, "Could not start seat checkout.");
  }
  redirect(checkoutUrl);
}

// v5: recurring auto-top-up schedules; v4 only refills at the fixed threshold.
export async function setGoatAutoRefillAction(input: {
  enabled: boolean;
  amountCents: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can manage auto-refill." };
  }
  if (
    !Number.isSafeInteger(input.amountCents) ||
    input.amountCents < GOAT_MIN_TOP_UP_USD_CENTS ||
    input.amountCents > GOAT_MAX_TOP_UP_USD_CENTS
  ) {
    return {
      ok: false,
      error: `Auto-refill amounts must be between $${GOAT_MIN_TOP_UP_USD_CENTS / 100} and $${GOAT_MAX_TOP_UP_USD_CENTS / 100}.`,
    };
  }
  try {
    const overview = await loadGoatBillingOverview(context.workspace.id);
    if (overview.billing.plan !== "pro") {
      return { ok: false, error: "Upgrade this workspace to Pro before enabling auto-refill." };
    }
    const updated = await setGoatAutoRefillConfig({
      workspaceId: context.workspace.id,
      enabled: input.enabled,
      amountCents: input.amountCents,
    });
    if (!updated) {
      return {
        ok: false,
        error: "Add credits once first — auto-refill charges the card saved during a top-up.",
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not update auto-refill.",
    };
  }
}

export async function createGoatBillingPortalAction(): Promise<GoatBillingActionResult> {
  const context = await currentGoatUser();
  if (context.role !== "admin") {
    return { ok: false, error: "Only workspace admins can manage billing." };
  }
  let portalUrl: string;
  try {
    const { billing } = await loadGoatBillingOverview(context.workspace.id);
    if (!billing.stripeCustomerId) {
      return {
        ok: false,
        error: "This workspace does not have a Stripe billing account yet.",
      };
    }
    const session = await getGoatStripe().billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: `${getGoatAppUrl()}/settings/workspace/billing`,
    });
    portalUrl = session.url;
  } catch (error) {
    return billingError(error, "Could not open Stripe billing management.");
  }
  redirect(portalUrl);
}
