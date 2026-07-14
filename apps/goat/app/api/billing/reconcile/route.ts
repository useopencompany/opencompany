import { releasePendingGoatIngestionReservations } from "@opencompany/db/goat-billing";

export const runtime = "nodejs";

// Hourly safety net for the paused-ingestion backlog. Releases normally happen
// opportunistically when the ingest worker claims jobs, but a workspace whose
// allowance freed up (monthly reset, upgrade, newly connected source) with no
// new inbound events would otherwise stay paused until the next claim.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { released, failed } = await releasePendingGoatIngestionReservations({
    maxWorkspaces: 200,
  });
  return Response.json({ released, failed });
}
