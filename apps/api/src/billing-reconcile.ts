import { sweepGoatAutoRefills } from "@opencompany/billing/auto-refill";
import { reconcileGoatStripeSeatQuantities } from "@opencompany/billing/seats";
import {
  refreshGoatMonthlyIncludedUsage,
  releasePendingGoatIngestionReservations,
} from "@opencompany/db/goat-billing";
import { reconcileGoatCapabilities } from "@opencompany/goat-agent/capabilities/reconcile";
import type Stripe from "stripe";

type DbLike = any;

export interface BillingReconcileService {
  reconcile(request: Request): Promise<Response>;
}

export function createBillingReconcileService(input: {
  db: DbLike;
  stripe: Stripe;
  secret: string;
}): BillingReconcileService {
  return {
    async reconcile(request) {
      if (!input.secret || request.headers.get("authorization") !== `Bearer ${input.secret}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      const [capabilities, ingestion, includedUsage, seats] = await Promise.all([
        reconcileGoatCapabilities(100, { db: input.db }),
        releasePendingGoatIngestionReservations({ maxWorkspaces: 200, db: input.db }),
        refreshGoatMonthlyIncludedUsage({ limit: 500, db: input.db }),
        reconcileGoatStripeSeatQuantities(100, { db: input.db, stripe: input.stripe }),
      ]);
      const autoRefills = await sweepGoatAutoRefills(25, {
        db: input.db,
        stripe: input.stripe,
      });
      return Response.json({
        released: ingestion.released,
        failed: ingestion.failed,
        autoRefills,
        includedUsage,
        seats,
        capabilities,
      });
    },
  };
}
