import {
  listStripeSeatReconciliationCandidates,
  loadBillingOverview,
  reconcileStripeSeatQuantity,
} from "@opencompany/db/billing";
import { getDb } from "@opencompany/db/client";
import type Stripe from "stripe";
import { getStripe } from "./stripe";

type DbLike = any;

export async function syncStripeSeatQuantityForWorkspace(
  workspaceId: string,
  deps: { db?: DbLike; stripe?: Stripe } = {},
) {
  const db: DbLike = deps.db ?? getDb();
  const overview = await loadBillingOverview(workspaceId, { db });
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
  const stripe = deps.stripe ?? getStripe();
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

  await reconcileStripeSeatQuantity(
    {
      workspaceId,
      seatQuantity: quantity,
    },
    { db },
  );
  return { ok: true as const, changed, quantity };
}

export async function reconcileStripeSeatQuantities(
  limit = 100,
  deps: { db?: DbLike; stripe?: Stripe } = {},
) {
  const db: DbLike = deps.db ?? getDb();
  const candidates = await listStripeSeatReconciliationCandidates({ limit, db });
  let reconciled = 0;
  let changed = 0;
  let failed = 0;
  for (const workspaceId of candidates) {
    try {
      const result = await syncStripeSeatQuantityForWorkspace(workspaceId, {
        db,
        ...(deps.stripe ? { stripe: deps.stripe } : {}),
      });
      if (result.ok) reconciled += 1;
      if (result.ok && result.changed) changed += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `[opencompany] Failed to reconcile Stripe seats for workspace ${workspaceId}.`,
        error,
      );
    }
  }
  return { candidates: candidates.length, reconciled, changed, failed };
}
