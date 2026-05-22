"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentWorkspace } from "@/lib/auth";
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

  const stripe = getStripe();
  const appUrl = getAppUrl();
  const { authUser, user, workspace } = await getCurrentWorkspace();
  const checkoutRecordId = newStripeCheckoutRecordId();
  const metadata = {
    workspaceId: workspace.id,
    userId: user.id,
    amountCents: String(amountCents),
    checkoutRecordId,
  };

  await createPendingCheckoutRecord({
    id: checkoutRecordId,
    workspaceId: workspace.id,
    userId: user.id,
    amountCents,
  });

  let checkoutUrl: string;
  try {
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

    await markCheckoutRecordOpen({
      id: checkoutRecordId,
      stripeCheckoutSessionId: session.id,
      metadata: {
        ...metadata,
        stripeCheckoutSessionId: session.id,
      },
    });
    checkoutUrl = session.url;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start checkout.";
    await markCheckoutRecordFailed({ id: checkoutRecordId, error: message });
    return { ok: false as const, error: message };
  }

  redirect(checkoutUrl);
}

export async function redeemCreditCode(code: string) {
  const { user, workspace } = await getCurrentWorkspace();
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
