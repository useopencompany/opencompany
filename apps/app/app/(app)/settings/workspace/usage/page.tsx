import { loadBillingOverview } from "@opencompany/db/billing";
import { loadSpendBreakdown } from "@opencompany/db/credits";
import { type UsageData, UsagePanel } from "@/components/IngestionUsagePanel";
import { currentUser } from "@/lib/auth";

export default async function WorkspaceUsageSettingsPage() {
  const context = await currentUser();
  const [overview, breakdown] = await Promise.all([
    loadBillingOverview(context.workspace.id),
    loadSpendBreakdown(context.workspace.id, { days: 30 }),
  ]);
  return (
    <UsagePanel
      data={{
        breakdown,
        ingestedThisMonth: overview.ingestedThisMonth,
        pending: overview.pending,
        creditBalanceUsdMicros: overview.creditBalanceUsdMicros,
        providers: overview.providers,
        recent: overview.recent.map(
          (
            item: Omit<UsageData["recent"][number], "createdAt"> & {
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
