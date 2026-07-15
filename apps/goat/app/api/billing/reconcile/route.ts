import { releasePendingGoatIngestionReservations } from "@opencompany/db/goat-billing";
import { reconcileGoatSeatQuantities } from "@/lib/billing/seat-sync";

export const runtime = "nodejs";

// Hourly safety net for the paused-ingestion backlog and drifted seat counts.
// Backlog releases normally happen opportunistically when the ingest worker
// claims jobs, but a workspace whose allowance freed up (monthly reset,
// upgrade, credit top-up) with no new inbound events would otherwise stay
// paused until the next claim. Seat quantities normally sync fire-and-forget
// on membership changes; this repairs missed pushes and webhooks.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { released, failed } = await releasePendingGoatIngestionReservations({
    maxWorkspaces: 200,
  });
  const seats = await reconcileGoatSeatQuantities(50);
  return Response.json({ released, failed, seats });
}
