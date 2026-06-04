import { captureServerEvent } from "@opencompany/analytics/server";
import { after, NextResponse } from "next/server";
import Stripe from "stripe";
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
    const result = await fulfillCheckoutSession(event.data.object, { eventId: event.id });

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

  return NextResponse.json({ received: true });
}
