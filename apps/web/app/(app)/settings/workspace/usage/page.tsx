import { loadGoatBillingOverview } from "@opencompany/db/goat-billing";
import { loadGoatSpendBreakdown } from "@opencompany/db/goat-credits";
import { type GoatUsageData, GoatUsagePanel } from "@/components/GoatIngestionUsagePanel";
import { currentGoatUser } from "@/lib/auth";

export default async function WorkspaceUsageSettingsPage() {
  const context = await currentGoatUser();
  const [overview, breakdown] = await Promise.all([
    loadGoatBillingOverview(context.workspace.id),
    loadGoatSpendBreakdown(context.workspace.id, { days: 30 }),
  ]);
  return (
    <GoatUsagePanel
      data={{
        breakdown,
        ingestedThisMonth: overview.ingestedThisMonth,
        pending: overview.pending,
        creditBalanceUsdMicros: overview.creditBalanceUsdMicros,
        providers: overview.providers,
        recent: overview.recent.map(
          (
            item: Omit<GoatUsageData["recent"][number], "createdAt"> & {
              createdAt: Date;
            },
          ) => ({
            ...item,
            createdAt: item.createdAt.toISOString(),
          }),
        ),
      }}
    />
  );
}
