import { listGoatSeatSyncCandidates, loadGoatBillingOverview } from "@opencompany/db/goat-billing";
import { countGoatWorkspaceMembers } from "@opencompany/db/goat-workspaces";
import { createLogger } from "@opencompany/observability";
import { getGoatStripe } from "@/lib/billing/stripe";

const logger = createLogger({ service: "opencompany-goat", runtime: "goat-seat-sync" });

// Stateless seat sync: push the live member count to the Stripe subscription
// item; the resulting customer.subscription.updated webhook is the single
// writer of workspace_billing.seat_quantity. Callers fire-and-forget —
// membership changes must never fail on Stripe — and the hourly reconcile
// cron repairs anything a missed call or webhook left drifted.
export async function syncGoatWorkspaceSeatQuantity(workspaceId: string): Promise<void> {
  try {
    const overview = await loadGoatBillingOverview(workspaceId);
    if (overview.plan !== "pro" || !overview.billing.stripeSubscriptionItemId) return;
    const memberCount = Math.max(1, await countGoatWorkspaceMembers(workspaceId));
    if (memberCount === overview.billing.seatQuantity) return;
    await pushSeatQuantity({
      workspaceId,
      stripeSubscriptionItemId: overview.billing.stripeSubscriptionItemId,
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

// Hourly backstop for missed fire-and-forget syncs and webhooks.
export async function reconcileGoatSeatQuantities(limit = 50) {
  const candidates = await listGoatSeatSyncCandidates({ limit });
  let synced = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      await pushSeatQuantity({
        workspaceId: candidate.workspaceId,
        stripeSubscriptionItemId: candidate.stripeSubscriptionItemId,
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

async function pushSeatQuantity(input: {
  workspaceId: string;
  stripeSubscriptionItemId: string;
  fromSeatQuantity: number;
  toSeatQuantity: number;
}) {
  await getGoatStripe().subscriptionItems.update(input.stripeSubscriptionItemId, {
    quantity: input.toSeatQuantity,
    proration_behavior: "create_prorations",
  });
  logger.info("Goat seat quantity pushed to Stripe", {
    event: "goat.seat_quantity_pushed",
    workspace_id: input.workspaceId,
    from_seat_quantity: input.fromSeatQuantity,
    to_seat_quantity: input.toSeatQuantity,
  });
}
