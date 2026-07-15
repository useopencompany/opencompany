import { listGoatSeatSyncCandidates, loadGoatBillingOverview } from "@opencompany/db/goat-billing";
import { countGoatWorkspaceMembers } from "@opencompany/db/goat-workspaces";
import { createLogger } from "@opencompany/observability";
import { getGoatProPriceId, getGoatStripe } from "@/lib/billing/stripe";

const logger = createLogger({ service: "opencompany-goat", runtime: "goat-seat-sync" });

// Stateless billing sync: push the live member count and current Pro price to
// the Stripe subscription item. The resulting customer.subscription.updated
// webhook remains the single writer of projected billing state. Callers
// fire-and-forget, and the hourly reconcile repairs missed calls or webhooks.
export async function syncGoatWorkspaceSeatQuantity(workspaceId: string): Promise<void> {
  try {
    const overview = await loadGoatBillingOverview(workspaceId);
    if (overview.plan !== "pro" || !overview.billing.stripeSubscriptionItemId) return;
    const memberCount = Math.max(1, await countGoatWorkspaceMembers(workspaceId));
    const targetPriceId = getGoatProPriceId();
    if (
      memberCount === overview.billing.seatQuantity &&
      overview.billing.stripePriceId === targetPriceId
    ) {
      return;
    }
    await pushSubscriptionTerms({
      workspaceId,
      stripeSubscriptionItemId: overview.billing.stripeSubscriptionItemId,
      fromPriceId: overview.billing.stripePriceId,
      toPriceId: targetPriceId,
      fromSeatQuantity: overview.billing.seatQuantity,
      toSeatQuantity: memberCount,
    });
  } catch (error) {
    logger.warn("Goat seat sync failed", {
      event: "goat.seat_sync_failed",
      workspace_id: workspaceId,
      error,
    });
  }
}

// Hourly backstop also migrates subscriptions that still use an old Pro price.
export async function reconcileGoatSeatQuantities(limit = 50) {
  const targetPriceId = getGoatProPriceId();
  const candidates = await listGoatSeatSyncCandidates({ limit, targetPriceId });
  let synced = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      await pushSubscriptionTerms({
        workspaceId: candidate.workspaceId,
        stripeSubscriptionItemId: candidate.stripeSubscriptionItemId,
        fromPriceId: candidate.stripePriceId,
        toPriceId: targetPriceId,
        fromSeatQuantity: candidate.seatQuantity,
        toSeatQuantity: candidate.memberCount,
      });
      synced += 1;
    } catch (error) {
      failed += 1;
      logger.warn("Goat seat reconcile failed for workspace", {
        event: "goat.seat_reconcile_failed",
        workspace_id: candidate.workspaceId,
        error,
      });
    }
  }
  return { candidates: candidates.length, synced, failed };
}

async function pushSubscriptionTerms(input: {
  workspaceId: string;
  stripeSubscriptionItemId: string;
  fromPriceId: string | null;
  toPriceId: string;
  fromSeatQuantity: number;
  toSeatQuantity: number;
}) {
  await getGoatStripe().subscriptionItems.update(input.stripeSubscriptionItemId, {
    price: input.toPriceId,
    quantity: input.toSeatQuantity,
    proration_behavior: "create_prorations",
  });
  logger.info("Goat subscription terms pushed to Stripe", {
    event: "goat.subscription_terms_pushed",
    workspace_id: input.workspaceId,
    price_changed: input.fromPriceId !== input.toPriceId,
    from_seat_quantity: input.fromSeatQuantity,
    to_seat_quantity: input.toSeatQuantity,
  });
}
