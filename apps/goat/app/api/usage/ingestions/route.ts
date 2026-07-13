import { loadGoatBillingOverview } from "@opencompany/db/goat-billing";
import { currentGoatUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  const context = await currentGoatUser({ optional: true });
  if (!context) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const overview = await loadGoatBillingOverview(context.workspace.id);
  return Response.json(
    {
      plan: overview.plan,
      period: {
        start: overview.window.start.toISOString(),
        resetAt: overview.window.resetAt.toISOString(),
      },
      used: overview.used,
      limit: overview.window.limit,
      pending: overview.pending,
      providers: overview.providers,
      recent: overview.recent,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
