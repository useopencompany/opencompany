import { captureServerEvent } from "@opencompany/analytics/server";
import {
  checkWorkspaceRunAllowance,
  usdMicrosToCents,
  type WorkspaceRunAllowance,
} from "@opencompany/billing";
import { getDb } from "@opencompany/db/client";
import { captureException } from "@opencompany/observability";
import { after } from "next/server";
import type Stripe from "stripe";
import {
  fulfillAutoRefill,
  hasRecentAutoRefillAttempt,
  insertAutoRefillAttempt,
  loadWorkspaceBillingSettings,
  markAutoRefillAttemptFailed,
  newAutoRefillAttemptId,
  saveAutoRefillPaymentMethod,
} from "@/lib/billing/service";
import { getStripe } from "@/lib/billing/stripe";

type Db = ReturnType<typeof getDb>;

// Skip a fresh charge if one was attempted within this window. Guards against
// several concurrent run gates each firing an off-session charge.
export const AUTO_REFILL_COOLDOWN_MS = 2 * 60 * 1000;

// Stripe rejects charges under $0.50; the settings validator enforces a higher
// floor, but we re-check here defensively before charging.
const STRIPE_MIN_CHARGE_CENTS = 50;

export type AutoRefillResult = { recharged: boolean };

// Attempts an off-session top-up if the workspace is eligible. Eligibility:
// auto-refill enabled, healthy (not needs_attention), a saved card, an amount,
// the balance is below threshold, the workspace is NOT capped by the weekly limit
// (topping up wouldn't help), and no recent attempt (cooldown).
//
// On a synchronous Stripe success we credit immediately (the webhook is an
// idempotent backstop) so the caller can re-check and let the run proceed.
export async function maybeTriggerAutoRefill(input: {
  workspaceId: string;
  allowance: WorkspaceRunAllowance;
  userId?: string | null;
  db?: Db;
}): Promise<AutoRefillResult> {
  const db = input.db ?? getDb();
  const { allowance } = input;

  // Never refill into a wall — if the weekly cap is the blocker, money won't help.
  if (allowance.reason === "weekly_limit_reached") return { recharged: false };

  const settings = await loadWorkspaceBillingSettings(input.workspaceId, db);
  if (
    !settings ||
    !settings.autoRefillEnabled ||
    settings.autoRefillStatus !== "ok" ||
    !settings.stripeCustomerId ||
    !settings.stripeDefaultPaymentMethodId ||
    !settings.autoRefillAmountUsdMicros ||
    settings.autoRefillAmountUsdMicros <= 0
  ) {
    return { recharged: false };
  }

  // Only refill when actually below the configured threshold.
  if (
    settings.autoRefillThresholdUsdMicros != null &&
    allowance.balanceUsdMicros >= settings.autoRefillThresholdUsdMicros
  ) {
    return { recharged: false };
  }

  const amountCents = usdMicrosToCents(settings.autoRefillAmountUsdMicros);
  if (amountCents < STRIPE_MIN_CHARGE_CENTS) return { recharged: false };

  if (await hasRecentAutoRefillAttempt(input.workspaceId, AUTO_REFILL_COOLDOWN_MS, db)) {
    return { recharged: false };
  }

  const attemptId = newAutoRefillAttemptId();
  await insertAutoRefillAttempt({
    id: attemptId,
    workspaceId: input.workspaceId,
    userId: input.userId ?? null,
    amountUsdMicros: settings.autoRefillAmountUsdMicros,
    db,
  });

  try {
    const paymentIntent = await getStripe().paymentIntents.create(
      {
        amount: amountCents,
        currency: "usd",
        customer: settings.stripeCustomerId,
        payment_method: settings.stripeDefaultPaymentMethodId,
        off_session: true,
        confirm: true,
        metadata: { kind: "auto_refill", workspaceId: input.workspaceId, attemptId },
      },
      // attemptId is unique per attempt, so retrying create() is safe.
      { idempotencyKey: `autorefill_${attemptId}` },
    );

    if (paymentIntent.status === "succeeded") {
      const result = await fulfillAutoRefill({
        attemptId,
        stripePaymentIntentId: paymentIntent.id,
        db,
      });
      after(() =>
        captureServerEvent("auto_refill_succeeded", input.userId ?? input.workspaceId, {
          workspace_id: input.workspaceId,
          amount_cents: amountCents,
          attempt_id: attemptId,
        }),
      );
      return { recharged: result.ok || result.alreadyFulfilled };
    }

    // requires_action / processing — we can't unblock the user synchronously.
    await markAutoRefillAttemptFailed({
      attemptId,
      workspaceId: input.workspaceId,
      stripePaymentIntentId: paymentIntent.id,
      error: `payment_intent_status_${paymentIntent.status}`,
      needsAttention: true,
    });
    return { recharged: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "auto_refill_charge_failed";
    await markAutoRefillAttemptFailed({
      attemptId,
      workspaceId: input.workspaceId,
      error: message,
      needsAttention: true,
    });
    captureException(error, {
      event: "opencompany.auto_refill_failed",
      workspace_id: input.workspaceId,
      attempt_id: attemptId,
    });
    after(() =>
      captureServerEvent("auto_refill_failed", input.userId ?? input.workspaceId, {
        workspace_id: input.workspaceId,
        attempt_id: attemptId,
        error: message,
      }),
    );
    return { recharged: false };
  }
}

// Backstop entry point for the Inngest sweep: loads the current allowance for a
// workspace and runs the same eligibility + charge logic.
export async function runAutoRefillForWorkspace(workspaceId: string): Promise<AutoRefillResult> {
  const db = getDb();
  const allowance = await checkWorkspaceRunAllowance({ db, workspaceId });
  return maybeTriggerAutoRefill({ workspaceId, allowance, db });
}

// ── Stripe webhook handlers ──────────────────────────────────────────────────

function stripeIdOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

// Completes a setup-mode checkout: retrieves the saved card, marks it the
// customer's default, and persists it so auto-refill can charge it off-session.
export async function completeAutoRefillSetup(session: Stripe.Checkout.Session) {
  if (session.mode !== "setup") return;
  const workspaceId = session.metadata?.workspaceId;
  const customerId = stripeIdOf(session.customer);
  const setupIntentId = stripeIdOf(session.setup_intent);
  if (!workspaceId || !customerId || !setupIntentId) return;

  const stripe = getStripe();
  const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
  const paymentMethodId = stripeIdOf(setupIntent.payment_method);
  if (!paymentMethodId) return;

  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  await saveAutoRefillPaymentMethod({
    workspaceId,
    stripeCustomerId: customerId,
    paymentMethodId,
    cardBrand: paymentMethod.card?.brand ?? null,
    cardLast4: paymentMethod.card?.last4 ?? null,
  });
}

// Idempotent backstop for an off-session refill that succeeded — the inline path
// usually credits first; fulfillAutoRefill no-ops if already done.
export async function handleAutoRefillPaymentIntentSucceeded(
  paymentIntent: Stripe.PaymentIntent,
  eventId: string,
) {
  if (paymentIntent.metadata?.kind !== "auto_refill") return;
  const attemptId = paymentIntent.metadata.attemptId;
  if (!attemptId) return;
  await fulfillAutoRefill({ attemptId, stripePaymentIntentId: paymentIntent.id, eventId });
}

export async function handleAutoRefillPaymentIntentFailed(paymentIntent: Stripe.PaymentIntent) {
  if (paymentIntent.metadata?.kind !== "auto_refill") return;
  const attemptId = paymentIntent.metadata.attemptId;
  const workspaceId = paymentIntent.metadata.workspaceId;
  if (!attemptId || !workspaceId) return;
  await markAutoRefillAttemptFailed({
    attemptId,
    workspaceId,
    stripePaymentIntentId: paymentIntent.id,
    error: paymentIntent.last_payment_error?.message ?? "auto_refill_payment_failed",
    needsAttention: true,
  });
}
