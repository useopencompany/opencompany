import { loadBillingOverview } from "@opencompany/db/billing";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  const context = await currentUser({ optional: true });
  if (!context) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const overview = await loadBillingOverview(context.workspace.id);
  return Response.json(
    {
      ingestedThisMonth: overview.ingestedThisMonth,
      creditBalanceUsdMicros: overview.creditBalanceUsdMicros,
      pending: overview.pending,
      providers: overview.providers,
      recent: overview.recent,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
