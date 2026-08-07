import {
  refreshMonthlyIncludedUsage,
  releasePendingIngestionReservations,
} from "@opencompany/db/billing";
import { sweepAutoRefills } from "@/lib/billing/auto-refill";
import { reconcileStripeSeatQuantities } from "@/lib/billing/seats";
import { reconcileCapabilities } from "@/lib/capabilities/reconcile";

export const runtime = "nodejs";

// Hourly safety net for the paused-ingestion backlog and pending auto-refills.
// Backlog releases normally happen right after a top-up fulfills (webhook) or
// when the ingest worker claims jobs; auto-refills normally trigger after chat
// debits in-app. This sweep covers workspaces whose balance drained through
// runner-side ingestion debits with no chat activity, and any missed webhook.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [capabilities, ingestion, includedUsage, seats] = await Promise.all([
    reconcileCapabilities(100),
    releasePendingIngestionReservations({
      maxWorkspaces: 200,
    }),
    refreshMonthlyIncludedUsage({ limit: 500 }),
    reconcileStripeSeatQuantities(100),
  ]);
  const autoRefills = await sweepAutoRefills(25);
  return Response.json({
    released: ingestion.released,
    failed: ingestion.failed,
    autoRefills,
    includedUsage,
    seats,
    capabilities,
  });
}
