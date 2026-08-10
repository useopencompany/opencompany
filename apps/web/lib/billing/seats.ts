import {
  listGoatStripeSeatReconciliationCandidates,
  loadGoatBillingOverview,
  reconcileGoatStripeSeatQuantity,
} from "@opencompany/db/goat-billing";
import { getGoatStripe } from "@/lib/billing/stripe";

export async function syncGoatStripeSeatQuantityForWorkspace(workspaceId: string) {
  const overview = await loadGoatBillingOverview(workspaceId);
  const itemId = overview.billing.stripeSubscriptionItemId;
  const status = overview.billing.subscriptionStatus;
  if (
    overview.billing.plan !== "pro" ||
    !itemId ||
    status === "canceled" ||
    status === "incomplete_expired" ||
    status === "unpaid"
  ) {
    return { ok: false as const, reason: "no_active_subscription" as const };
  }

  const quantity = Math.max(1, overview.memberCount);
  const stripe = getGoatStripe();
  const item = await stripe.subscriptionItems.retrieve(itemId);
  const stripeQuantity = Math.max(1, item.quantity ?? 1);
  let changed = false;
  if (stripeQuantity !== quantity) {
    await stripe.subscriptionItems.update(itemId, {
      quantity,
      proration_behavior: "create_prorations",
    });
    changed = true;
  }

  await reconcileGoatStripeSeatQuantity({
    workspaceId,
    seatQuantity: quantity,
  });
  return { ok: true as const, changed, quantity };
}

export async function reconcileGoatStripeSeatQuantities(limit = 100) {
  const candidates = await listGoatStripeSeatReconciliationCandidates({ limit });
  let reconciled = 0;
  let changed = 0;
  let failed = 0;
  for (const workspaceId of candidates) {
    try {
      const result = await syncGoatStripeSeatQuantityForWorkspace(workspaceId);
      if (result.ok) reconciled += 1;
      if (result.ok && result.changed) changed += 1;
    } catch (error) {
      failed += 1;
      console.error(`[goat] Failed to reconcile Stripe seats for workspace ${workspaceId}.`, error);
    }
  }
  return { candidates: candidates.length, reconciled, changed, failed };
}
