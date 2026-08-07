import { captureServerEvent } from "@opencompany/analytics/server";
import { captureServerEvent as captureSharedServerEvent } from "@opencompany/analytics/shared-server";
import {
  AUTO_REFILL_THRESHOLD_USD_MICROS,
  claimAutoRefill,
  ensureMonthlyIncludedUsage,
  listAutoRefillCandidates,
  releasePendingForWorkspace,
  settleAutoRefill,
} from "@opencompany/db/billing";
import {
  getCreditBalanceUsdMicros,
  recordAutoRefillCredit,
  usdMicrosToCents,
} from "@opencompany/db/credits";
import Stripe from "stripe";
import { assertCheckoutEnabled, getStripe } from "@/lib/billing/stripe";

// Off-session wallet refill. The DB lease claim (claimAutoRefill) is the
// concurrency guard — concurrent triggers charge at most once per cooldown —
// and the pi:{id} ledger idempotency key makes the synchronous credit and the
// payment_intent.succeeded webhook safe to both run. A card decline disables
// auto-refill (never loop on a failing card); transient errors keep it enabled
// and the claim cooldown paces the retry.

export async function maybeTriggerAutoRefill(workspaceId: string) {
  try {
    await ensureMonthlyIncludedUsage(workspaceId);
    const balance = await getCreditBalanceUsdMicros(workspaceId);
    if (balance >= AUTO_REFILL_THRESHOLD_USD_MICROS) return;
    await runAutoRefill(workspaceId);
  } catch (error) {
    console.error(`Auto-refill trigger failed for workspace ${workspaceId}.`, error);
  }
}

export async function runAutoRefill(workspaceId: string) {
  assertCheckoutEnabled();
  const claim = await claimAutoRefill(workspaceId);
  if (!claim) return { charged: false as const, reason: "not_claimed" as const };
  try {
    const intent = await getStripe().paymentIntents.create({
      amount: claim.amountCents,
      currency: "usd",
      customer: claim.stripeCustomerId,
      payment_method: claim.paymentMethodId,
      off_session: true,
      confirm: true,
      description: "OpenCompany credits auto-refill",
      metadata: {
        billingProduct: "goat_auto_refill",
        workspaceId: workspaceId,
        amountCents: String(claim.amountCents),
      },
    });
    if (intent.status !== "succeeded") {
      // Off-session charges cannot complete extra authentication steps.
      await settleAutoRefill({
        workspaceId,
        disable: true,
        error: `Auto-refill charge did not complete (status ${intent.status}).`,
      });
      await captureSharedServerEvent("goat_billing_auto_refill_failed", workspaceId, {
        workspace_id: workspaceId,
        amount_cents: claim.amountCents,
        reason: intent.status,
      });
      return { charged: false as const, reason: "not_succeeded" as const };
    }
    const credit = await recordAutoRefillCredit({
      workspaceId,
      amountCents: claim.amountCents,
      paymentIntentId: intent.id,
    });
    if (credit.ok) {
      await captureServerEvent("billing_topup_completed", workspaceId, {
        workspace_id: workspaceId,
        topup_type: "auto_refill",
        amount_cents: claim.amountCents,
        amount_usd: claim.amountCents / 100,
        balance_cents: usdMicrosToCents(credit.balanceUsdMicros),
      });
    }
    await settleAutoRefill({ workspaceId });
    // Resume any balance-paused ingestion immediately instead of waiting for
    // the hourly reconcile sweep.
    await releasePendingForWorkspace(workspaceId).catch(() => undefined);
    await captureSharedServerEvent("goat_billing_auto_refill_succeeded", workspaceId, {
      workspace_id: workspaceId,
      amount_cents: claim.amountCents,
    });
    return { charged: true as const };
  } catch (error) {
    const isCardError = error instanceof Stripe.errors.StripeCardError;
    await settleAutoRefill({
      workspaceId,
      disable: isCardError,
      error: error instanceof Error ? error.message : "Auto-refill charge failed.",
    }).catch(() => undefined);
    await captureSharedServerEvent("goat_billing_auto_refill_failed", workspaceId, {
      workspace_id: workspaceId,
      amount_cents: claim.amountCents,
      reason: isCardError ? "card_declined" : "charge_error",
    });
    return { charged: false as const, reason: "charge_failed" as const };
  }
}

// Reconcile-cron sweep: covers balance drops from debits recorded outside
// the app (the runner's ingestion debits).
export async function sweepAutoRefills(limit = 25) {
  const candidates = await listAutoRefillCandidates({ limit });
  let charged = 0;
  for (const workspaceId of candidates) {
    try {
      const result = await runAutoRefill(workspaceId);
      if (result.charged) charged += 1;
    } catch (error) {
      console.error(`Auto-refill sweep failed for workspace ${workspaceId}.`, error);
    }
  }
  return { candidates: candidates.length, charged };
}
