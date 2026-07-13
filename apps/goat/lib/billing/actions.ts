"use server";

import { captureServerEvent } from "@opencompany/analytics/server";
import {
  GOAT_PRO_MONTHLY_SEAT_PRICE_EUR_CENTS,
  loadGoatBillingOverview,
  setGoatStripeCustomerId,
} from "@opencompany/db/goat-billing";
import { redirect } from "next/navigation";
import { currentGoatUser } from "@/lib/auth";
import {
  assertGoatCheckoutEnabled,
  getGoatAppUrl,
  getGoatProPriceId,
  getGoatStripe,
} from "@/lib/billing/stripe";

export type GoatBillingActionResult = { ok: false; error: string } | never;

function billingError(error: unknown, fallback: string): GoatBillingActionResult {
  return {
    ok: false,
    error: error instanceof Error ? error.message : fallback,
  };
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
    if (overview.plan === "pro") {
      return {
        ok: false,
        error: "This workspace already has OpenCompany Pro.",
      };
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
    const stripe = getGoatStripe();
    let customerId = overview.billing.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: context.authUser.email,
        name: context.workspace.name,
        metadata: { goatWorkspaceId: context.workspace.id },
      });
      customerId =
        (await setGoatStripeCustomerId({
          workspaceId: context.workspace.id,
          stripeCustomerId: customer.id,
        })) ?? customer.id;
    }
    const appUrl = getGoatAppUrl();
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        success_url: `${appUrl}/settings/workspace/billing?checkout=success`,
        cancel_url: `${appUrl}/settings/workspace/billing?checkout=cancelled`,
        automatic_tax: { enabled: true },
        billing_address_collection: "required",
        tax_id_collection: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
        line_items: [{ price: getGoatProPriceId(), quantity: overview.seatCount }],
        metadata: {
          billingProduct: "goat",
          goatWorkspaceId: context.workspace.id,
        },
        subscription_data: {
          metadata: {
            billingProduct: "goat",
            goatWorkspaceId: context.workspace.id,
          },
        },
      },
      {
        idempotencyKey: `goat-pro-${context.workspace.id}-${Math.floor(Date.now() / 3_600_000)}`,
      },
    );
    if (!session.url) return { ok: false, error: "Stripe did not return a Checkout URL." };
    await captureServerEvent("goat_billing_checkout_started", context.user.workosUserId, {
      user_id: context.user.workosUserId,
      workspace_id: context.workspace.id,
      seat_quantity: overview.seatCount,
      subtotal_eur_cents: overview.seatCount * GOAT_PRO_MONTHLY_SEAT_PRICE_EUR_CENTS,
    });
    checkoutUrl = session.url;
  } catch (error) {
    return billingError(error, "Could not start OpenCompany Pro checkout.");
  }
  redirect(checkoutUrl);
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
