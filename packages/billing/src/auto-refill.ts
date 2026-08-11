import { captureGoatServerEvent } from "@opencompany/analytics/goat/server";
import { captureServerEvent } from "@opencompany/analytics/server";
import {
  claimGoatAutoRefill,
  ensureGoatMonthlyIncludedUsage,
  GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS,
  listGoatAutoRefillCandidates,
  releasePendingForWorkspace,
  settleGoatAutoRefill,
} from "@opencompany/db/goat-billing";
import {
  getGoatCreditBalanceUsdMicros,
  goatUsdMicrosToCents,
  recordGoatAutoRefillCredit,
} from "@opencompany/db/goat-credits";
import Stripe from "stripe";
import { assertGoatCheckoutEnabled, getGoatStripe } from "./stripe";

// Off-session wallet refill. The DB lease claim (claimGoatAutoRefill) is the
// concurrency guard — concurrent triggers charge at most once per cooldown —
// and the pi:{id} ledger idempotency key makes the synchronous credit and the
// payment_intent.succeeded webhook safe to both run. A card decline disables
// auto-refill (never loop on a failing card); transient errors keep it enabled
// and the claim cooldown paces the retry.

export async function maybeTriggerGoatAutoRefill(workspaceId: string) {
  try {
    await ensureGoatMonthlyIncludedUsage(workspaceId);
    const balance = await getGoatCreditBalanceUsdMicros(workspaceId);
    if (balance >= GOAT_AUTO_REFILL_THRESHOLD_USD_MICROS) return;
    await runGoatAutoRefill(workspaceId);
  } catch (error) {
    console.error(`Goat auto-refill trigger failed for workspace ${workspaceId}.`, error);
  }
}

export async function runGoatAutoRefill(workspaceId: string) {
  assertGoatCheckoutEnabled();
  const claim = await claimGoatAutoRefill(workspaceId);
  if (!claim) return { charged: false as const, reason: "not_claimed" as const };
  try {
    const intent = await getGoatStripe().paymentIntents.create({
      amount: claim.amountCents,
      currency: "usd",
      customer: claim.stripeCustomerId,
      payment_method: claim.paymentMethodId,
      off_session: true,
      confirm: true,
      description: "OpenCompany credits auto-refill",
      metadata: {
        billingProduct: "goat_auto_refill",
        goatWorkspaceId: workspaceId,
        amountCents: String(claim.amountCents),
      },
    });
    if (intent.status !== "succeeded") {
      // Off-session charges cannot complete extra authentication steps.
      await settleGoatAutoRefill({
        workspaceId,
        disable: true,
        error: `Auto-refill charge did not complete (status ${intent.status}).`,
      });
      await captureServerEvent("goat_billing_auto_refill_failed", workspaceId, {
        workspace_id: workspaceId,
        amount_cents: claim.amountCents,
        reason: intent.status,
      });
      return { charged: false as const, reason: "not_succeeded" as const };
    }
    const credit = await recordGoatAutoRefillCredit({
      workspaceId,
      amountCents: claim.amountCents,
      paymentIntentId: intent.id,
    });
    if (credit.ok) {
      await captureGoatServerEvent("billing_topup_completed", workspaceId, {
        workspace_id: workspaceId,
        topup_type: "auto_refill",
        amount_cents: claim.amountCents,
        amount_usd: claim.amountCents / 100,
        balance_cents: goatUsdMicrosToCents(credit.balanceUsdMicros),
      });
    }
    await settleGoatAutoRefill({ workspaceId });
    // Resume any balance-paused ingestion immediately instead of waiting for
    // the hourly reconcile sweep.
    await releasePendingForWorkspace(workspaceId).catch(() => undefined);
    await captureServerEvent("goat_billing_auto_refill_succeeded", workspaceId, {
      workspace_id: workspaceId,
      amount_cents: claim.amountCents,
    });
    return { charged: true as const };
  } catch (error) {
    const isCardError = error instanceof Stripe.errors.StripeCardError;
    await settleGoatAutoRefill({
      workspaceId,
      disable: isCardError,
      error: error instanceof Error ? error.message : "Auto-refill charge failed.",
    }).catch(() => undefined);
    await captureServerEvent("goat_billing_auto_refill_failed", workspaceId, {
      workspace_id: workspaceId,
      amount_cents: claim.amountCents,
      reason: isCardError ? "card_declined" : "charge_error",
    });
    return { charged: false as const, reason: "charge_failed" as const };
  }
}

// Reconcile-cron sweep: covers balance drops recorded by other composition
// roots, including the runner's ingestion debits.
export async function sweepGoatAutoRefills(limit = 25) {
  const candidates = await listGoatAutoRefillCandidates({ limit });
  let charged = 0;
  for (const workspaceId of candidates) {
    try {
      const result = await runGoatAutoRefill(workspaceId);
      if (result.charged) charged += 1;
    } catch (error) {
      console.error(`Goat auto-refill sweep failed for workspace ${workspaceId}.`, error);
    }
  }
  return { candidates: candidates.length, charged };
}
