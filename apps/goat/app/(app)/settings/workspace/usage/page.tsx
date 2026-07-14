import { loadGoatBillingOverview } from "@opencompany/db/goat-billing";
import {
  type GoatIngestionUsageData,
  GoatIngestionUsagePanel,
} from "@/components/GoatIngestionUsagePanel";
import { currentGoatUser } from "@/lib/auth";

export default async function WorkspaceUsageSettingsPage() {
  const context = await currentGoatUser();
  const overview = await loadGoatBillingOverview(context.workspace.id);
  return (
    <GoatIngestionUsagePanel
      data={{
        plan: overview.plan,
        used: overview.used,
        limit: overview.window.limit,
        baseLimit: overview.window.baseLimit,
        sourceBonus: overview.window.sourceBonus,
        pending: overview.pending,
        resetAt: overview.window.resetAt.toISOString(),
        providers: overview.providers,
        recent: overview.recent.map(
          (
            item: Omit<GoatIngestionUsageData["recent"][number], "createdAt"> & {
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
