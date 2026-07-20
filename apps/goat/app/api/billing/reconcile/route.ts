import { releasePendingGoatIngestionReservations } from "@opencompany/db/goat-billing";
import { sweepGoatAutoRefills } from "@/lib/billing/auto-refill";

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
  const autoRefills = await sweepGoatAutoRefills(25);
  const { released, failed } = await releasePendingGoatIngestionReservations({
    maxWorkspaces: 200,
  });
  return Response.json({ released, failed, autoRefills });
}
