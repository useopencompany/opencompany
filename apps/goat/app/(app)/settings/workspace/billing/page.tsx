import {
  GOAT_FREE_MONTHLY_INGESTION_LIMIT,
  GOAT_PRO_MONTHLY_INGESTION_LIMIT,
  GOAT_PRO_MONTHLY_PRICE_USD_CENTS,
  GOAT_SOURCE_BONUS_MAX_MONTHLY_ITEMS,
  GOAT_SOURCE_BONUS_MONTHLY_ITEMS,
  loadGoatBillingOverview,
} from "@opencompany/db/goat-billing";
import { GoatBillingPanel } from "@/components/GoatBillingPanel";
import { currentGoatUser } from "@/lib/auth";

export default async function WorkspaceBillingSettingsPage() {
  const context = await currentGoatUser();
  const overview = await loadGoatBillingOverview(context.workspace.id);
  return (
    <GoatBillingPanel
      data={{
        plan: overview.plan,
        subscriptionStatus: overview.billing.subscriptionStatus,
        cancelAtPeriodEnd: overview.billing.cancelAtPeriodEnd,
        currentPeriodEnd: overview.billing.currentPeriodEnd?.toISOString() ?? null,
        paymentNeedsAttention: overview.billing.paymentNeedsAttention,
        monthlyPriceUsdCents: GOAT_PRO_MONTHLY_PRICE_USD_CENTS,
        monthlyIngestionsUsed: overview.monthlyUsed,
        monthlyIngestionLimit: overview.window.limit,
        freeMonthlyLimit: GOAT_FREE_MONTHLY_INGESTION_LIMIT,
        proMonthlyLimit: GOAT_PRO_MONTHLY_INGESTION_LIMIT,
        sourceBonus: overview.window.sourceBonus,
        sourceBonusPerSource: GOAT_SOURCE_BONUS_MONTHLY_ITEMS,
        sourceBonusMax: GOAT_SOURCE_BONUS_MAX_MONTHLY_ITEMS,
        monthStartedAt: overview.monthWindow.start.toISOString(),
        monthResetAt: overview.monthWindow.resetAt.toISOString(),
        isAdmin: context.role === "admin",
      }}
    />
  );
}
