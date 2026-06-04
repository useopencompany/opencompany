"use server";

import { captureServerEvent } from "@opencompany/analytics/server";
import { captureException } from "@opencompany/observability";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { AUTHENTICATION_REQUIRED_MESSAGE, currentWorkspace } from "@/lib/auth";
import {
  isValidTopUpAmountCents,
  MAX_TOP_UP_AMOUNT_CENTS,
  MIN_TOP_UP_AMOUNT_CENTS,
} from "@/lib/billing/constants";
import {
  createPendingCheckoutRecord,
  markCheckoutRecordFailed,
  markCheckoutRecordOpen,
  newStripeCheckoutRecordId,
  redeemCreditCodeForWorkspace,
} from "@/lib/billing/service";
import { getAppUrl, getStripe } from "@/lib/billing/stripe";

function formatTopUpName(amountCents: number) {
  return `$${amountCents / 100} Open Company credits`;
}

export async function createCreditCheckoutSession(amountCents: number) {
  if (!isValidTopUpAmountCents(amountCents)) {
    return {
      ok: false as const,
      error: `Top-up amount must be between ${MIN_TOP_UP_AMOUNT_CENTS} and ${MAX_TOP_UP_AMOUNT_CENTS} cents.`,
    };
  }

  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const { authUser, user, workspace } = context;
  let checkoutRecordId: string | undefined;
  let pendingRecordCreated = false;
  let checkoutStage = "initialize";
  let checkoutUrl = "";
  const metadataBase = {
    workspaceId: workspace.id,
    userId: user.id,
    amountCents: String(amountCents),
  };

  try {
    const stripe = getStripe();
    const appUrl = getAppUrl();
    checkoutRecordId = newStripeCheckoutRecordId();
    const metadata = {
      ...metadataBase,
      checkoutRecordId,
    };

    checkoutStage = "create_pending_record";
    await createPendingCheckoutRecord({
      id: checkoutRecordId,
      workspaceId: workspace.id,
      userId: user.id,
      amountCents,
    });
    pendingRecordCreated = true;

    checkoutStage = "create_stripe_session";
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: authUser.email,
      success_url: `${appUrl}/settings?billing=success`,
      cancel_url: `${appUrl}/settings?billing=cancelled`,
      metadata,
      payment_intent_data: { metadata },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: { name: formatTopUpName(amountCents) },
          },
        },
      ],
    });

    if (!session.url) {
      await markCheckoutRecordFailed({
        id: checkoutRecordId,
        error: "Stripe did not return a Checkout URL.",
      });
      return { ok: false as const, error: "Stripe did not return a Checkout URL." };
    }

    checkoutStage = "mark_checkout_open";
    await markCheckoutRecordOpen({
      id: checkoutRecordId,
      stripeCheckoutSessionId: session.id,
      metadata: {
        ...metadata,
        stripeCheckoutSessionId: session.id,
      },
    });

    checkoutUrl = session.url;
    const capturedCheckoutRecordId = checkoutRecordId;
    after(() =>
      captureServerEvent("credit_top_up_started", user.id, {
        user_id: user.id,
        workspace_id: workspace.id,
        checkout_record_id: capturedCheckoutRecordId,
        amount_cents: amountCents,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start checkout.";

    captureException(error, {
      event: "opencompany.billing_checkout_failed",
      workspace_id: workspace.id,
      user_id: user.id,
      checkout_record_id: checkoutRecordId,
      amount_cents: amountCents,
      checkout_stage: checkoutStage,
    });

    if (checkoutRecordId && pendingRecordCreated) {
      try {
        await markCheckoutRecordFailed({ id: checkoutRecordId, error: message });
      } catch (markError) {
        captureException(markError, {
          event: "opencompany.billing_checkout_mark_failed",
          workspace_id: workspace.id,
          user_id: user.id,
          checkout_record_id: checkoutRecordId,
          amount_cents: amountCents,
        });
      }
    }

    return { ok: false as const, error: message };
  }

  redirect(checkoutUrl);
}

export async function redeemCreditCode(code: string) {
  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const { user, workspace } = context;
  const result = await redeemCreditCodeForWorkspace({
    code,
    workspaceId: workspace.id,
    userId: user.id,
  });

  if (result.ok) {
    revalidatePath("/settings");
    revalidatePath("/", "layout");
  }

  return result;
}
