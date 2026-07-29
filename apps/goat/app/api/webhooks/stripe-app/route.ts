import { NextResponse } from "next/server";
import { disconnectGoatStripeIntegrationForAccount } from "@/lib/integrations/stripe";
import { parseGoatStripeAppWebhook } from "@/lib/integrations/stripe-app-webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Stripe signature." }, { status: 400 });
  }

  let event;
  try {
    event = parseGoatStripeAppWebhook(await request.text(), signature);
  } catch {
    return NextResponse.json({ error: "Invalid Stripe app webhook." }, { status: 400 });
  }

  if (event.type === "account.application.deauthorized" && event.accountId) {
    await disconnectGoatStripeIntegrationForAccount({
      accountId: event.accountId,
      livemode: event.livemode,
    });
  }

  return NextResponse.json({ received: true });
}
