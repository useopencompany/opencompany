import { reconcileCapabilities } from "@opencompany/agent/capabilities/reconcile";
import { sweepAutoRefills } from "@opencompany/billing/auto-refill";
import { reconcileStripeSeatQuantities } from "@opencompany/billing/seats";
import {
  refreshMonthlyIncludedUsage,
  releasePendingIngestionReservations,
} from "@opencompany/db/billing";
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
        reconcileCapabilities(100, { db: input.db }),
        releasePendingIngestionReservations({ maxWorkspaces: 200, db: input.db }),
        refreshMonthlyIncludedUsage({ limit: 500, db: input.db }),
        reconcileStripeSeatQuantities(100, { db: input.db, stripe: input.stripe }),
      ]);
      const autoRefills = await sweepAutoRefills(25, {
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
