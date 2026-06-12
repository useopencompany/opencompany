import { captureServerEvent } from "@opencompany/analytics/server";
import { captureException } from "@opencompany/observability";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { AUTHENTICATION_REQUIRED_MESSAGE, currentWorkspace } from "@/lib/auth";
import { fulfillCheckoutSession } from "@/lib/billing/service";
import { getStripe } from "@/lib/billing/stripe";

function captureCreditTopUpCompleted(result: {
  checkoutRecordId: string;
  workspaceId: string;
  userId: string;
  amountCents: number;
  balanceCents: number;
  ledgerId: number;
}) {
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

function revalidateBillingSurfaces() {
  revalidatePath("/company/settings");
  revalidatePath("/personal/settings");
  revalidatePath("/", "layout");
}

export async function verifyCreditCheckoutSessionReturn(stripeCheckoutSessionId: string) {
  const normalizedSessionId = stripeCheckoutSessionId.trim();
  if (!normalizedSessionId.startsWith("cs_")) {
    return { ok: false as const, error: "Invalid Stripe Checkout Session." };
  }

  const context = await currentWorkspace({ optional: true });
  if (!context) {
    return { ok: false as const, error: AUTHENTICATION_REQUIRED_MESSAGE };
  }

  const { user, workspace } = context;

  try {
    const session = await getStripe().checkout.sessions.retrieve(normalizedSessionId);
    const metadata = session.metadata ?? {};

    if (metadata.workspaceId !== workspace.id || metadata.userId !== user.id) {
      const error = new Error("Stripe Checkout Session return metadata mismatch.");
      captureException(error, {
        event: "opencompany.billing_checkout_return_mismatch",
        workspace_id: workspace.id,
        user_id: user.id,
        stripe_checkout_session_id: normalizedSessionId,
        session_workspace_id: metadata.workspaceId,
        session_user_id: metadata.userId,
      });

      return { ok: false as const, error: "Could not verify checkout." };
    }

    const result = await fulfillCheckoutSession(session);
    if (result.ok) {
      captureCreditTopUpCompleted(result);
      revalidateBillingSurfaces();
      return { ok: true as const, status: "fulfilled" as const };
    }

    if (result.reason === "already_fulfilled") {
      revalidateBillingSurfaces();
      return { ok: true as const, status: "already_fulfilled" as const };
    }

    if (result.reason === "not_paid") {
      return { ok: false as const, error: "Payment has not completed yet." };
    }

    const error = new Error(`Stripe checkout return fulfillment failed: ${result.reason}`);
    captureException(error, {
      event: "opencompany.billing_checkout_return_fulfillment_failed",
      workspace_id: workspace.id,
      user_id: user.id,
      stripe_checkout_session_id: normalizedSessionId,
      fulfillment_reason: result.reason,
    });

    return { ok: false as const, error: "Could not verify checkout." };
  } catch (error) {
    captureException(error, {
      event: "opencompany.billing_checkout_return_failed",
      workspace_id: workspace.id,
      user_id: user.id,
      stripe_checkout_session_id: normalizedSessionId,
    });

    return { ok: false as const, error: "Could not verify checkout." };
  }
}
