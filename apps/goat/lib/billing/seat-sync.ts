import { captureServerEvent } from "@opencompany/analytics/server";
import {
  completeGoatSeatSync,
  listGoatBillingSeatSyncCandidates,
  loadGoatBillingOverview,
  markGoatSeatSyncPending,
} from "@opencompany/db/goat-billing";
import { getGoatStripe } from "@/lib/billing/stripe";

export async function syncGoatWorkspaceSeatQuantity(workspaceId: string) {
  const quantity = await markGoatSeatSyncPending(workspaceId);
  const { billing } = await loadGoatBillingOverview(workspaceId);
  if (billing.plan !== "pro" || !billing.stripeSubscriptionItemId) {
    return { synced: false as const, quantity, reason: "not_pro" as const };
  }
  await getGoatStripe().subscriptionItems.update(billing.stripeSubscriptionItemId, {
    quantity,
    proration_behavior: "create_prorations",
  });
  await completeGoatSeatSync({ workspaceId, quantity });
  if (billing.stripeSeatQuantity !== null && billing.stripeSeatQuantity !== quantity) {
    await captureServerEvent("goat_billing_seat_quantity_changed", workspaceId, {
      workspace_id: workspaceId,
      previous_quantity: billing.stripeSeatQuantity,
      seat_quantity: quantity,
    });
  }
  return { synced: true as const, quantity };
}

export async function reconcileGoatWorkspaceSeatQuantities(limit = 50) {
  const candidates = await listGoatBillingSeatSyncCandidates(limit);
  const results: Array<{ workspaceId: string; ok: boolean; error?: string }> = [];
  for (const candidate of candidates) {
    try {
      await syncGoatWorkspaceSeatQuantity(candidate.workspaceId);
      results.push({ workspaceId: candidate.workspaceId, ok: true });
    } catch (error) {
      results.push({
        workspaceId: candidate.workspaceId,
        ok: false,
        error: error instanceof Error ? error.message : "Seat reconciliation failed.",
      });
    }
  }
  return results;
}
