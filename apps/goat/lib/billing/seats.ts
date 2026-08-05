import { loadGoatBillingOverview } from "@opencompany/db/goat-billing";
import { getGoatStripe } from "@/lib/billing/stripe";

export async function syncGoatStripeSeatQuantityForWorkspace(workspaceId: string) {
  const overview = await loadGoatBillingOverview(workspaceId);
  const itemId = overview.billing.stripeSubscriptionItemId;
  const status = overview.billing.subscriptionStatus;
  if (!itemId || status === "canceled" || status === "incomplete_expired" || status === "unpaid") {
    return { ok: false as const, reason: "no_active_subscription" as const };
  }

  const quantity = Math.max(1, overview.memberCount);
  if (quantity === overview.billing.seatQuantity) {
    return { ok: true as const, changed: false as const, quantity };
  }

  await getGoatStripe().subscriptionItems.update(itemId, {
    quantity,
    proration_behavior: "create_prorations",
  });
  return { ok: true as const, changed: true as const, quantity };
}
