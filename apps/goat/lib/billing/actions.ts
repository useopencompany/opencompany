"use server";

import { randomUUID } from "node:crypto";
import { captureServerEvent } from "@opencompany/analytics/server";
import {
  loadGoatBillingOverview,
  setGoatAutoRefillConfig,
  setGoatStripeCustomerId,
} from "@opencompany/db/goat-billing";
import {
  GOAT_MAX_TOP_UP_USD_CENTS,
  GOAT_MIN_TOP_UP_USD_CENTS,
} from "@opencompany/db/goat-billing-constants";
import {
  createGoatPendingCheckoutRecord,
  markGoatCheckoutRecordFailed,
  markGoatCheckoutRecordOpen,
} from "@opencompany/db/goat-credits";
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

// Self-serve: any workspace member can top up the shared wallet.
export async function createGoatCreditTopUpAction(
  amountCents: number,
): Promise<GoatBillingActionResult> {
  const context = await currentGoatUser();
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
    assertGoatCheckoutEnabled();
    const overview = await loadGoatBillingOverview(context.workspace.id);
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

// v5: recurring auto-top-up schedules; v4 only refills at the fixed threshold.
export async function setGoatAutoRefillAction(input: {
  enabled: boolean;
  amountCents: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const context = await currentGoatUser();
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
